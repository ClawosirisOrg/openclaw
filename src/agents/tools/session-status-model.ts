import { randomUUID } from "node:crypto";
import { readAcpSessionMetaForEntry } from "../../acp/runtime/session-meta-readonly.js";
import type { ThinkLevel, ThinkingCatalogEntry } from "../../auto-reply/thinking.js";
import {
  formatThinkingLevels,
  isSessionDefaultDirectiveValue,
  isThinkingLevelSupported,
  normalizeThinkLevel,
} from "../../auto-reply/thinking.js";
import { patchSessionEntryWithKey, type SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withSessionStatusModelPatchOrigin } from "../../gateway/session-model-patch-origin.js";
import { triggerSessionPatchHook } from "../../gateway/session-patch-hooks.js";
import type { SessionsPatchResult } from "../../gateway/session-utils.types.js";
import {
  isPluginMetadataSnapshotCompatible,
  resolvePluginMetadataSnapshot,
} from "../../plugins/plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { applyModelOverrideWithAuthProfileCompatibility } from "../../sessions/auth-profile-preservation.js";
import {
  buildModelAliasIndex,
  modelKey,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
} from "../model-selection.js";
import { createModelVisibilityPolicy } from "../model-visibility-policy.js";
import { loadPublishedPreparedModelCatalog } from "../prepared-model-catalog.js";
import { resolveSessionModelRef } from "../session-model-ref.js";
import { resolveEffectiveAgentRuntime } from "../thinking-runtime.js";
import { normalizeToolModelOverride } from "./common.js";
import type { AgentToolGatewayRequestCaller } from "./in-process-gateway.js";
import type { resolveSessionStatusEntry } from "./session-status-session-resolve.js";

type ResolvedStatusSession = NonNullable<ReturnType<typeof resolveSessionStatusEntry>>;

async function resolveModelOverride(params: {
  cfg: OpenClawConfig;
  raw: string;
  sessionEntry?: SessionEntry;
  agentId: string;
  agentDir: string;
  workspaceDir: string;
  metadataSnapshot?: PluginMetadataSnapshot;
}): Promise<
  | { kind: "reset" }
  | {
      kind: "set";
      provider: string;
      model: string;
      isDefault: boolean;
    }
> {
  const raw = normalizeToolModelOverride(params.raw);
  if (!raw) {
    return { kind: "reset" };
  }

  const configDefault = resolveDefaultModelForAgent({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  const currentProvider = params.sessionEntry?.providerOverride?.trim() || configDefault.provider;

  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    agentId: params.agentId,
    defaultProvider: currentProvider,
  });
  const catalog = await loadPublishedPreparedModelCatalog({
    config: params.cfg,
    agentId: params.agentId,
    agentDir: params.agentDir,
    readOnly: true,
    ...(params.sessionEntry?.spawnedWorkspaceDir
      ? { workspaceDir: params.sessionEntry.spawnedWorkspaceDir }
      : {}),
  });
  const workspaceDir = params.sessionEntry?.spawnedWorkspaceDir ?? params.workspaceDir;
  const manifestMetadataSnapshot =
    params.metadataSnapshot &&
    params.metadataSnapshot.pluginIds === undefined &&
    isPluginMetadataSnapshotCompatible({
      snapshot: params.metadataSnapshot,
      config: params.cfg,
      env: process.env,
      workspaceDir,
    })
      ? params.metadataSnapshot
      : resolvePluginMetadataSnapshot({
          config: params.cfg,
          ...(workspaceDir ? { workspaceDir } : {}),
          env: process.env,
        });
  const modelManifestContext = {
    manifestPlugins: manifestMetadataSnapshot,
  };
  const policy = createModelVisibilityPolicy({
    cfg: params.cfg,
    catalog,
    defaultProvider: currentProvider,
    defaultModel: configDefault,
    agentId: params.agentId,
    allowManifestNormalization: true,
    allowPluginNormalization: true,
    ...modelManifestContext,
  });

  const resolved = resolveModelRefFromString({
    cfg: params.cfg,
    agentId: params.agentId,
    raw,
    defaultProvider: currentProvider,
    aliasIndex,
    allowManifestNormalization: true,
    allowPluginNormalization: true,
    ...modelManifestContext,
  });
  if (!resolved) {
    throw new Error(`Unrecognized model "${raw}".`);
  }
  const key = modelKey(resolved.ref.provider, resolved.ref.model);
  if (!policy.allows(resolved.ref)) {
    throw new Error(`Model "${key}" is not allowed.`);
  }
  const isDefault =
    resolved.ref.provider === configDefault.provider && resolved.ref.model === configDefault.model;
  return {
    kind: "set",
    provider: resolved.ref.provider,
    model: resolved.ref.model,
    isDefault,
  };
}

function resolveValidatedThinkingLevel(params: {
  raw: string;
  cfg: OpenClawConfig;
  entry: SessionEntry;
  agentId: string;
  sessionKey: string;
  catalog: ThinkingCatalogEntry[];
}): ThinkLevel {
  const selected = resolveSessionModelRef(params.cfg, params.entry, params.agentId);
  const level = normalizeThinkLevel(params.raw);
  // ACP metadata can own canonical agent keys, so its backend must override
  // key/config-derived runtime policy when validating thinking.
  const acpMeta = readAcpSessionMetaForEntry({
    sessionKey: params.sessionKey,
    entry: params.entry,
  });
  const agentRuntime =
    acpMeta?.backend ??
    resolveEffectiveAgentRuntime({
      cfg: params.cfg,
      provider: selected.provider,
      modelId: selected.model,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      sessionEntry: params.entry,
    });
  const hint = formatThinkingLevels(
    selected.provider,
    selected.model,
    ", ",
    params.catalog,
    agentRuntime,
  );
  if (
    !level ||
    !isThinkingLevelSupported({
      provider: selected.provider,
      model: selected.model,
      level,
      catalog: params.catalog,
      agentRuntime,
    })
  ) {
    throw new Error(
      `Thinking level "${params.raw}" is not supported for ${selected.provider}/${selected.model}. Use one of: ${hint}.`,
    );
  }
  return level;
}

/** Gateway requests use the mutation owner; standalone runs retain their local store contract. */
export async function patchSessionStatusModel(params: {
  cfg: OpenClawConfig;
  agentId: string;
  agentDir: string;
  workspaceDir: string;
  storePath: string;
  raw?: string;
  thinkingLevel?: string;
  resolved: ResolvedStatusSession;
  metadataSnapshot?: PluginMetadataSnapshot;
  gatewayCall?: AgentToolGatewayRequestCaller;
}): Promise<{ resolved: ResolvedStatusSession; changedModel: boolean }> {
  const { cfg, agentId, resolved } = params;
  const thinkingLevelRaw = params.thinkingLevel;
  const resetsThinkingLevel =
    thinkingLevelRaw !== undefined && isSessionDefaultDirectiveValue(thinkingLevelRaw);
  if (params.gatewayCall) {
    const gatewayCall = params.gatewayCall;
    const { result, applied } = await withSessionStatusModelPatchOrigin(() =>
      gatewayCall<SessionsPatchResult>({
        method: "sessions.patch",
        params: {
          key: resolved.key,
          agentId,
          ...(resolved.persisted
            ? {
                ...(resolved.entry.sessionId.trim()
                  ? { expectedSessionId: resolved.entry.sessionId }
                  : {}),
                expectedLifecycleRevision: resolved.entry.lifecycleRevision,
              }
            : {}),
          ...(params.raw !== undefined
            ? { model: normalizeToolModelOverride(params.raw) ?? null }
            : {}),
          ...(thinkingLevelRaw !== undefined
            ? { thinkingLevel: resetsThinkingLevel ? null : thinkingLevelRaw }
            : {}),
        },
      }),
    );
    return {
      resolved: { key: result.key, entry: result.entry, persisted: true },
      changedModel: params.raw !== undefined && applied,
    };
  }

  const configured = resolveDefaultModelForAgent({ cfg, agentId });
  const selectedAgentDir = params.agentDir;
  const selectedWorkspaceDir = params.workspaceDir;
  const storePath = params.storePath;
  const modelRaw = params.raw;
  let scopedResolved = resolved;
  let modelSelection:
    | {
        provider: string;
        model: string;
        isDefault: boolean;
      }
    | undefined;
  let modelPatchValue: string | null | undefined;
  if (typeof modelRaw === "string") {
    const selection = await resolveModelOverride({
      cfg,
      raw: modelRaw,
      sessionEntry: scopedResolved.entry,
      agentId,
      agentDir: selectedAgentDir,
      workspaceDir: selectedWorkspaceDir,
      metadataSnapshot: params.metadataSnapshot,
    });
    modelSelection =
      selection.kind === "reset"
        ? {
            provider: configured.provider,
            model: configured.model,
            isDefault: true,
          }
        : {
            provider: selection.provider,
            model: selection.model,
            isDefault: selection.isDefault,
          };
    modelPatchValue = selection.kind === "reset" ? null : `${selection.provider}/${selection.model}`;
  }

  const mutationThinkingCatalog =
    thinkingLevelRaw !== undefined && !resetsThinkingLevel
      ? await loadPublishedPreparedModelCatalog({
          config: cfg,
          agentId,
          agentDir: selectedAgentDir,
          readOnly: true,
          ...(scopedResolved.entry.spawnedWorkspaceDir
            ? { workspaceDir: scopedResolved.entry.spawnedWorkspaceDir }
            : {}),
        })
      : [];

  const prospectiveEntry: SessionEntry = { ...scopedResolved.entry };
  let changedModel = false;
  let changedThinking = false;
  if (modelSelection) {
    changedModel = applyModelOverrideWithAuthProfileCompatibility({
      cfg,
      agentDir: selectedAgentDir,
      entry: prospectiveEntry,
      currentProvider:
        prospectiveEntry.providerOverride?.trim() ||
        prospectiveEntry.modelProvider?.trim() ||
        configured.provider,
      selection: modelSelection,
      explicitDefaultSelection: modelSelection.isDefault,
      markLiveSwitchPending: true,
    }).updated;
  }
  if (thinkingLevelRaw !== undefined) {
    if (resetsThinkingLevel) {
      changedThinking = prospectiveEntry.thinkingLevel !== undefined;
      delete prospectiveEntry.thinkingLevel;
    } else {
      const thinkingLevel = resolveValidatedThinkingLevel({
        raw: thinkingLevelRaw,
        cfg,
        entry: prospectiveEntry,
        agentId,
        sessionKey: scopedResolved.key,
        catalog: mutationThinkingCatalog,
      });
      changedThinking = prospectiveEntry.thinkingLevel !== thinkingLevel;
      prospectiveEntry.thinkingLevel = thinkingLevel;
    }
  }

  if (changedModel || changedThinking) {
    const patchResult = await patchSessionEntryWithKey(
      {
        agentId,
        sessionKey: scopedResolved.key,
        storePath,
      },
      (entry, context) => {
        const persistedEntryPatch: SessionEntry = { ...entry };
        changedModel = modelSelection
          ? applyModelOverrideWithAuthProfileCompatibility({
              cfg,
              agentDir: selectedAgentDir,
              entry: persistedEntryPatch,
              currentProvider:
                entry.providerOverride?.trim() ||
                entry.modelProvider?.trim() ||
                configured.provider,
              selection: modelSelection,
              explicitDefaultSelection: modelSelection.isDefault,
              markLiveSwitchPending: true,
            }).updated
          : false;
        if (thinkingLevelRaw !== undefined) {
          if (resetsThinkingLevel) {
            changedThinking = persistedEntryPatch.thinkingLevel !== undefined;
            delete persistedEntryPatch.thinkingLevel;
          } else {
            const thinkingLevel = resolveValidatedThinkingLevel({
              raw: thinkingLevelRaw,
              cfg,
              entry: persistedEntryPatch,
              agentId,
              sessionKey: scopedResolved.key,
              catalog: mutationThinkingCatalog,
            });
            changedThinking = persistedEntryPatch.thinkingLevel !== thinkingLevel;
            persistedEntryPatch.thinkingLevel = thinkingLevel;
          }
          if (changedThinking && !changedModel) {
            persistedEntryPatch.updatedAt = Date.now();
            // Keep a pending agent model-revert marker aligned with an
            // independent thinking choice so rollback cannot clobber it.
            if (persistedEntryPatch.modelFallback?.source === "agent-patch") {
              persistedEntryPatch.modelFallback = {
                ...persistedEntryPatch.modelFallback,
                prevThinkingLevel: persistedEntryPatch.thinkingLevel,
              };
            }
          }
        } else {
          changedThinking = false;
        }
        if (!persistedEntryPatch.sessionId.trim() && !context.existingEntry?.sessionId?.trim()) {
          persistedEntryPatch.sessionId = randomUUID();
        }
        return persistedEntryPatch;
      },
      {
        fallbackEntry: scopedResolved.persisted ? undefined : scopedResolved.entry,
        replaceEntry: true,
      },
    );
    if (!patchResult) {
      throw new Error(`Unknown sessionKey: ${scopedResolved.key}`);
    }
    const persistedEntry = patchResult.entry;
    scopedResolved = {
      entry: persistedEntry,
      key: patchResult.sessionKey,
      persisted: true,
    };
    if (changedModel || changedThinking) {
      triggerSessionPatchHook({
        cfg,
        sessionEntry: persistedEntry,
        sessionKey: patchResult.sessionKey,
        patch: {
          key: patchResult.sessionKey,
          ...(changedModel ? { model: modelPatchValue } : {}),
          ...(changedThinking
            ? {
                thinkingLevel: resetsThinkingLevel ? null : persistedEntry.thinkingLevel,
              }
            : {}),
        },
      });
    }
  }

  return { resolved: scopedResolved, changedModel };
}

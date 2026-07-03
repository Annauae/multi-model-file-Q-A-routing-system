import type { Express } from "express";
import { KbStore } from "./db/stores/kbStore.js";
import { QuestionsCache } from "./services/questionsCache.js";
import { ModelsStore } from "./db/stores/modelsStore.js";
import { MatchProfilesStore } from "./db/stores/matchProfilesStore.js";
import { PromptsStore } from "./db/stores/promptsStore.js";
import { OperationLog } from "./db/stores/operationLog.js";

export interface AppContext {
    kbStore: KbStore;
    cache: QuestionsCache;
    modelsStore: ModelsStore;
    matchProfilesStore: MatchProfilesStore;
    promptsStore: PromptsStore;
    opLog: OperationLog;
    settings: ReturnType<typeof import("./config.js").loadSettings>;
}

export function createApp(ctx: AppContext, clientDist?: string): Express;
export function createAppContext(): Promise<AppContext>;

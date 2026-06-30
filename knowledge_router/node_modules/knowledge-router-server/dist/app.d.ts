import { type Express } from "express";
import { type Settings } from "./config.js";
import { KbStore } from "./services/kbStore.js";
import { QuestionsCache } from "./services/questionsCache.js";
import { ModelsStore } from "./services/modelsStore.js";
import { MatchProfilesStore } from "./services/matchProfilesStore.js";
import { PromptsStore } from "./services/promptsStore.js";
import { OperationLog } from "./services/operationLog.js";
export interface AppContext {
    settings: Settings;
    kbStore: KbStore;
    cache: QuestionsCache;
    modelsStore: ModelsStore;
    matchProfilesStore: MatchProfilesStore;
    promptsStore: PromptsStore;
    opLog: OperationLog;
}
export declare function createAppContext(): AppContext;
export declare function createApp(ctx: AppContext, clientDist?: string): Express;

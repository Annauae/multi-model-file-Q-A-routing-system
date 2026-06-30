import type { Settings } from "../config.js";
import type { ModelSlotConfig } from "../types.js";
export declare const SLOTS: readonly ["match", "import", "pdf_vlm"];
export type SlotName = (typeof SLOTS)[number];
export declare const MASK = "***";
export declare function parseEnableThinking(val: unknown): boolean | null;
export declare class ModelsStore {
    private filePath;
    private defaults;
    private slots;
    constructor(filePath: string, defaults: Record<string, ModelSlotConfig>);
    static fromSettings(settings: Settings): ModelsStore;
    private loadOrSeed;
    private save;
    toDict(cfg: ModelSlotConfig, maskKey: boolean): Record<string, unknown>;
    getSlot(slot: string): ModelSlotConfig;
    getAll(maskKey?: boolean): Record<string, Record<string, unknown>>;
    updateSlot(slot: string, patch: Record<string, unknown>): Record<string, unknown>;
    updateAll(body: Record<string, unknown>): Record<string, Record<string, unknown>>;
}

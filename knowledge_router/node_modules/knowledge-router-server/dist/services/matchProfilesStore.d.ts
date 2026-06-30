import type { MatchProfile } from "../types.js";
import { ModelsStore } from "./modelsStore.js";
export declare const DEFAULT_PROFILE_ID = "default";
export declare class MatchProfilesStore {
    private filePath;
    private seedFrom?;
    private profiles;
    private defaultId;
    constructor(filePath: string, seedFrom?: ReturnType<ModelsStore["getSlot"]> | undefined);
    static open(filePath: string, modelsStore?: ModelsStore): MatchProfilesStore;
    private loadOrSeed;
    private seedEmpty;
    private save;
    toDict(p: MatchProfile, maskKey: boolean): Record<string, unknown>;
    listProfiles(maskKey?: boolean): Record<string, unknown>[];
    getDefaultId(): string;
    get(profileId?: string): MatchProfile;
    updateAll(body: Record<string, unknown>): {
        default_id: string;
        profiles: Record<string, unknown>[];
    };
}

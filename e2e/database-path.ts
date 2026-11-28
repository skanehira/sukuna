import { join } from "node:path";

export const databasePath = (home: string) => join(home, "data", "sukuna", "sukuna.db");

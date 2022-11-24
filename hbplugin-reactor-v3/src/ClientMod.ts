import { ModFlags } from "@skeldjs/reactor/v3";
import chalk from "chalk";

export class ClientMod {
    constructor(
        public readonly modId: string,
        public readonly flags: ModFlags,
        public readonly modVersion: string,
        public readonly netId: number|undefined
    ) {}

    isNetworked(): this is { netId: number; } {
        return (this.flags & ModFlags.RequireOnAllClients) > 0;
    }

    [Symbol.for("nodejs.util.inspect.custom")]() {
        return chalk.green(this.modId) + chalk.grey("@" + this.modVersion) + (this.netId !== undefined ? " (netid " + this.netId + ")" : "");
    }
}

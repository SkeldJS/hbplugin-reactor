import { ModPluginSide } from "@skeldjs/reactor/v2";
import chalk from "chalk";

export class ClientMod {
    constructor(
        public readonly netId: number,
        public readonly modId: string,
        public readonly modVersion: string,
        public readonly networkSide: ModPluginSide
    ) {}

    [Symbol.for("nodejs.util.inspect.custom")]() {
        return chalk.green(this.modId) + chalk.grey("@" + this.modVersion);
    }
}

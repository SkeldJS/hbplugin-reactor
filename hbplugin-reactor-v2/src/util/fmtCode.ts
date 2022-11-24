import { GameCode } from "@skeldjs/hindenburg";

export function fmtCode(code: number) {
    return code === 0x20 ? "LOCAL" : GameCode.convertIntToString(code);
}

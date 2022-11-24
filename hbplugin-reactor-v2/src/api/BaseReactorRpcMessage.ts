import { BaseMessage } from "@skeldjs/hindenburg";

export class BaseReactorRpcMessage extends BaseMessage {
    static messageType = "reactorRpc" as const;
    messageType = "reactorRpc" as const;

    static modId = "";
    modId = "";
}

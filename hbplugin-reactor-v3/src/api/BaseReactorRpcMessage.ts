import { BaseMessage } from "@skeldjs/hindenburg";

export class BaseReactorRpcMessage extends BaseMessage {
    static messageType = "reactor-rpc" as const;
    messageType = "reactor-rpc" as const;

    static modId = "";
    modId = "";
}

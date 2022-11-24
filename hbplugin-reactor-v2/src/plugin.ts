import {
    HindenburgPlugin,
    WorkerPlugin,
    Worker,
    MessageHandler,
    PacketContext,
    RegisterMessage,
    MessageHandlerCallback,
    ReliablePacket,
    AcknowledgePacket,
    DisconnectReason,
    Language,
    ClientConnectEvent,
    Connection,
    Networkable,
    NetworkableEvents,
    Room,
    PlayerData,
    RpcMessage,
    Plugin,
    EventListener,
    WorkerLoadPluginEvent,
    RoomCreateEvent,
    WorkerBeforeJoinEvent,
    SpawnType,
    CliCommand
} from "@skeldjs/hindenburg";

import {
    ModdedHelloPacket,
    ModPluginSide,
    ReactorHandshakeMessage,
    ReactorMessage,
    ReactorMod,
    ReactorModDeclarationMessage
} from "@skeldjs/reactor/v2";

import minimatch from "minimatch";
import chalk from "chalk";

import { ClientMod } from "./ClientMod";
import { BaseReactorRpcMessage, getPluginReactorRpcHandlers } from "./api";
import i18n from "./i18n";
import { chunkArr } from "./util/chunkArr";
import { fmtCode } from "./util/fmtCode";
import { ReactorPluginDeclarationMessage, ReactorRpcMessage } from "./packets";

export interface ReactorModConfig {
    /**
     * Whether this mod is optional, and clients can connect without it. If the
     * client does have this mod, then it still must be the same version as the
     * one specified in {@link ReactorModConfig.version}.
     * @default false
     */
    optional: boolean;
    /**
     * Whether this mod is banned, only really applies when {@link ReactorConfig.allowExtraMods}
     * is enabled, as otherwise, only mods in the {@link ReactorConfig.mods} would
     * be accepted anyway.
     * @default false
     */
    banned: boolean;
    /**
     * Enforce a specific version glob for this mod.
     * @default *
     */
    version: string;
    /**
     * Whether to broadcast messages sent by this mod.
     * @default true
     */
    doNetworking: boolean;
}

export interface ReactorPluginConfig {
    /**
     * Whether to block reactor RPCs from mods that are declared as being client-side-only.
     * @default true
     */
    blockClientSideOnly: boolean;
    /**
     * Individual configuration for each mod in regards to how Hindenburg should
     * treat them.
     */
    mods: Record<string, ReactorModConfig|boolean>;
    /**
     * Whether to allow extra mods aside from those in {@link ReactorConfig.mods},
     * which would still be used to enforce certain version of mods, and to require
     * certain mods.
     * @default true
     */
    allowExtraMods: boolean;
    /**
     * Whether to allow normal clients to connect.
     * @default false
     */
    allowNormalClients: boolean;
    /**
     * Whether or not to require joining clients to have the same mods as the host.
     * @default true
     */
    requireHostMods: boolean;
    /**
     * Whether or not Reactor support is enabled.
     * @default true
     */
    enabled: boolean;
}

export class ReactorClient {
    expectedNumMods: number;
    clientMods: Map<string, ClientMod>;
    clientModsByNetId: ClientMod[];
    awaitingJoinRoom: number;

    constructor() {
        this.expectedNumMods = 0;
        this.clientMods = new Map;
        this.clientModsByNetId = [];
        this.awaitingJoinRoom = 0;
    }
}

@RegisterMessage(ModdedHelloPacket)
@RegisterMessage(ReactorMessage)
@RegisterMessage(ReactorHandshakeMessage)
@RegisterMessage(ReactorModDeclarationMessage)
@RegisterMessage(ReactorPluginDeclarationMessage)
@RegisterMessage(ReactorRpcMessage)
@HindenburgPlugin("hbplugin-reactor")
export class ReactorPlugin extends WorkerPlugin {
    protected reactorClients: WeakMap<Connection, ReactorClient>;

    protected reactorRpcHandlers: WeakMap<Room, Map<typeof BaseReactorRpcMessage, ((component: Networkable, rpc: BaseReactorRpcMessage) => any)[]>>;
    protected reactorRpcs: WeakMap<Worker|Room, Map<`${string}:${number}`, typeof BaseReactorRpcMessage>>;

    /**
      * All reactor rpc message handlers that were loaded into the worker, created with
      * {@link ReactorRpcHandler}.
      */
    protected allPluginsLoadedReactorRpcHandlers: WeakMap<Plugin, {
        reactorRpc: typeof BaseReactorRpcMessage,
        handler: (component: Networkable, rpc: BaseReactorRpcMessage) => any
    }[]>;

    constructor(public readonly worker: Worker, public config: ReactorPluginConfig) {
        super(worker, config);

        this.reactorClients = new WeakMap;

        this.reactorRpcHandlers = new WeakMap;
        this.reactorRpcs = new WeakMap;

        this.allPluginsLoadedReactorRpcHandlers = new WeakMap;
    }

    getReactorClient(connection: Connection) {
        return this.reactorClients.get(connection);
    }

    @MessageHandler(ReactorModDeclarationMessage)
    async onModDeclarationMessage(message: ReactorModDeclarationMessage, { sender }: PacketContext) {
        if (!sender)
            return;

        const reactorClient = this.getReactorClient(sender);

        if (!reactorClient)
            return;

        if (reactorClient.clientMods.size >= reactorClient.expectedNumMods)
            return;

        const clientMod = new ClientMod(
            message.netId,
            message.mod.modId,
            message.mod.version,
            message.mod.networkSide
        );

        reactorClient.clientMods.set(clientMod.modId, clientMod);
        if (!this.config.blockClientSideOnly || clientMod.networkSide === ModPluginSide.Both)
            reactorClient.clientModsByNetId[clientMod.netId] = clientMod;

        if (reactorClient.clientMods.size === 4) {
            this.logger.info("... Got more mods from %s, use '%s' to see more",
                sender, chalk.green("list mods " + sender.clientId));
        } else if (reactorClient.clientMods.size < 4) {
            this.logger.info("Got mod from %s: %s",
                sender, clientMod);
        }

        if (reactorClient.clientMods.size >= reactorClient.expectedNumMods) {
            if (reactorClient.awaitingJoinRoom) {
                await this.worker.attemptJoin(sender, reactorClient.awaitingJoinRoom);
                reactorClient.awaitingJoinRoom = 0;
            }
        }
    }

    @MessageHandler(ModdedHelloPacket, { override: true })
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async onModdedHello(message: ModdedHelloPacket, { sender }: PacketContext, _originalHandlers: MessageHandlerCallback<ModdedHelloPacket>[]) {
        if (!sender)
            return;

        if (sender.hasIdentified)
            return;

        sender.receivedPackets.unshift(message.helloPacket.nonce);
        sender.receivedPackets.splice(8);

        await sender.sendPacket(
            new AcknowledgePacket(
                message.helloPacket.nonce,
                []
            )
        );

        sender.hasIdentified = true;
        sender.username = message.helloPacket.username;
        sender.chatMode = message.helloPacket.chatMode;
        sender.language = message.helloPacket.language;
        sender.clientVersion = message.helloPacket.clientVer;
        sender.platform = message.helloPacket.platform;
        sender.playerLevel = 0;

        if (!message.isNormalHello()) {
            this.reactorClients.set(sender, new ReactorClient);
        }

        const reactorClient = this.reactorClients.get(sender);
        if (reactorClient) {
            reactorClient.expectedNumMods = message.modCount!;
        }

        if (!this.worker.isVersionAccepted(sender.clientVersion)) {
            this.logger.warn("%s connected with invalid client version: %s",
                sender, sender.clientVersion.toString());
            sender.disconnect(DisconnectReason.IncorrectVersion);
            return;
        }

        this.logger.info("%s connected, language: %s (%s)",
            sender, Language[sender.language] || "Unknown", reactorClient ? "using reactor" : "not using reactor");

        if (reactorClient) {
            if (!this.config.enabled) {
                sender.disconnect(i18n.reactor_not_enabled_on_server);
                return;
            }

            await sender.sendPacket(
                new ReliablePacket(
                    sender.getNextNonce(),
                    [
                        new ReactorMessage(
                            new ReactorHandshakeMessage("Hindenburg", "1.0.0", this.worker.loadedPlugins.size)
                        )
                    ]
                )
            );

            const entries = [...this.worker.loadedPlugins];
            const chunkedPlugins = chunkArr(entries, 4);
            for (let i = 0; i < chunkedPlugins.length; i++) {
                const chunk = chunkedPlugins[i];

                sender.sendPacket(
                    new ReliablePacket(
                        sender.getNextNonce(),
                        chunk.map(([ , plugin ]) =>
                            new ReactorMessage(
                                new ReactorPluginDeclarationMessage(
                                    i,
                                    new ReactorMod(
                                        plugin.pluginInstance.meta.id,
                                        plugin.pluginInstance.meta.version,
                                        ModPluginSide.Both
                                    )
                                )
                            )
                        )
                    )
                );
            }
        } else {
            if (!this.config.allowNormalClients) {
                sender.disconnect(i18n.reactor_required_on_server);
                return;
            }
        }

        await this.worker.emit(
            new ClientConnectEvent(sender)
        );
    }

    @MessageHandler(RpcMessage, { override: true })
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async onRpcMessage(message: RpcMessage, { sender }: PacketContext, _originalHandlers: MessageHandlerCallback<RpcMessage>[]) {
        if (!sender)
            return;

        const player = sender.getPlayer();
        if (!player)
            return;

        const reactorRpcMessage = message.data as unknown as ReactorRpcMessage;
        if (reactorRpcMessage.messageTag === 0xff) {
            message.cancel();
            const reactorClient = this.getReactorClient(sender);

            if (!reactorClient)
                return;

            const componentNetId = message.netId;
            const modNetId = reactorRpcMessage.modNetId;

            const component = sender.room?.netobjects.get(componentNetId);

            const senderMod = reactorClient.clientModsByNetId[modNetId];

            if (!component) {
                this.logger.warn("Got reactor rpc from %s for unknown component with netid %s",
                    sender, componentNetId);
                return;
            }

            if (!senderMod) {
                this.logger.warn("Got reactor rpc from %s for unknown mod with netid %s",
                    sender, modNetId);
                return;
            }

            if (senderMod.networkSide === ModPluginSide.Clientside) {
                if (this.config.blockClientSideOnly) {
                    this.logger.warn("Got reactor rpc from %s for client-side-only reactor mod %s",
                        sender, senderMod);

                    return;
                }
            }

            const roomReactorRpcs = this.reactorRpcs.get(player.room);
            const roomReactorRpcHandlers = this.reactorRpcHandlers.get(player.room);

            if (!roomReactorRpcs || !roomReactorRpcHandlers)
                return;

            const reactorRpc = roomReactorRpcs.get(`${senderMod.modId}:${reactorRpcMessage.customRpc.messageTag}`);

            if (reactorRpc) {
                const rpcHandlers = roomReactorRpcHandlers.get(reactorRpc);
                if (rpcHandlers) {
                    for (let i = 0; i < rpcHandlers.length; i++) {
                        const handler = rpcHandlers[i];
                        handler(component, reactorRpcMessage.customRpc);
                    }
                }
            }

            const modConfig = this.config.mods[senderMod.modId];
            if (typeof modConfig === "object") {
                if (modConfig.doNetworking === false) { // doNetworking can be undefined and is defaulted to true
                    return false;
                }
            }

            for (const [ , receiverClient ] of sender.room!.connections) {
                if (receiverClient === sender)
                    continue;

                const receiverReactorClient = this.getReactorClient(receiverClient);

                if (!receiverReactorClient)
                    continue;

                const receiverMod = receiverReactorClient.clientMods.get(senderMod.modId);

                if (!receiverMod)
                    continue;

                sender.room!.broadcastMessages([
                    new RpcMessage(
                        message.netId,
                        new ReactorRpcMessage(
                            receiverMod.netId,
                            reactorRpcMessage.customRpc
                        )
                    )
                ], undefined, [ receiverClient ]);
            }
        }
    }

    @EventListener("worker.beforejoin")
    async beforeJoinEvent(ev: WorkerBeforeJoinEvent) {
        const roomHost = ev.alteredRoom?.host;
        const reactorClient = this.getReactorClient(ev.client);

        if (reactorClient?.clientMods) {
            if (reactorClient.clientMods.size < reactorClient.expectedNumMods) {
                this.logger.info("Didn't get all mods from %s, waiting before joining %s",
                    ev.client, fmtCode(ev.gameCode));

                reactorClient.awaitingJoinRoom = ev.gameCode;
                ev.cancel();
                return;
            }

            if (!this.checkClientMods(ev.client))
                return;
        }

        if (this.config.requireHostMods && roomHost) {
            const hostConnection = ev.alteredRoom.connections.get(roomHost.clientId);
            if (hostConnection) {
                const hostReactorClient = this.getReactorClient(hostConnection);

                if (hostReactorClient && !reactorClient) {
                    return ev.client.disconnect(i18n.reactor_required_for_room);
                }

                if (!hostReactorClient && reactorClient) {
                    return ev.client.disconnect(i18n.reactor_not_enabled_for_room);
                }

                if (hostReactorClient && reactorClient) {
                    for (const [ hostModId, hostMod ] of hostReactorClient.clientMods) {
                        if (hostMod.networkSide === ModPluginSide.Clientside && this.config.blockClientSideOnly)
                            continue;

                        const clientMod = reactorClient.clientMods.get(hostModId);

                        if (!clientMod) {
                            return ev.client.disconnect(i18n.missing_required_mod,
                                hostMod.modId, hostMod.modVersion);
                        }

                        if (clientMod.modVersion !== hostMod.modVersion) {
                            return ev.client.disconnect(i18n.bad_mod_version,
                                clientMod.modId, clientMod.modVersion, hostMod.modVersion);
                        }
                    }

                    for (const [ clientModId, clientMod ] of reactorClient.clientMods) {
                        if (clientMod.networkSide === ModPluginSide.Clientside && this.config.blockClientSideOnly)
                            continue;

                        const hostMod = hostReactorClient.clientMods.get(clientModId);

                        if (!hostMod) {
                            return ev.client.disconnect(i18n.mod_not_recognised,
                                clientMod.modId);
                        }
                    }
                }
            }
        }
    }

    @EventListener("worker.loadplugin")
    onPluginLoaded(ev: WorkerLoadPluginEvent) {
        if (ev.reverted)
            return;

        const reactorRpcs = getPluginReactorRpcHandlers(ev.plugin);
        this.allPluginsLoadedReactorRpcHandlers.set(ev.plugin, [...reactorRpcs]);

        if (ev.isRoomPlugin()) {
            this.applyReactorRpcHandlers(ev.room);
        }
    }

    @EventListener("room.create")
    onRoomCreate(ev: RoomCreateEvent) {
        this.applyReactorRpcHandlers(ev.room);
    }

    @CliCommand({ usage: "list mods <clientid>" })
    async onCliCommand(args: any) {
        for (const [ , connection ] of this.worker.connections) {
            if (
                connection.clientId === args["client id"]
            ) {
                const reactorClient = this.getReactorClient(connection);

                if (!reactorClient) {
                    this.logger.info("%s has 0 mods", connection);
                    return;
                }

                this.logger.info("%s has %s mod%s", connection, reactorClient.clientMods.size, reactorClient.clientMods.size === 1 ? "" : "s");
                const mods = [...reactorClient.clientMods];
                for (let i = 0; i < mods.length; i++) {
                    const [ , mod ] = mods[i];
                    this.logger.info("%s) %s", i + 1, mod);
                }
                return;
            }
        }
        this.logger.error("Couldn't find client with id: " + args["client id"]);
    }

    protected async _sendReactorRpc(component: Networkable<unknown, NetworkableEvents, Room>, rpc: BaseReactorRpcMessage, player: PlayerData) {
        const playerConnection = component.room.connections.get(player.clientId);

        if (playerConnection) {
            const reactorClient = this.getReactorClient(playerConnection);

            if (!reactorClient)
                return this.logger.warn("Tried to send reactor rpc to player not using reactor %s (from net id %s, %s, rpc tag %s)",
                    player, component.netId, SpawnType[component.spawnType] || "unknown spawn type", rpc.messageTag);

            const targetMod = reactorClient.clientMods.get(rpc.modId);

            if (!targetMod)
                return this.logger.warn("Tried to send reactor rpc to player %s without mod with net id %s (%s) for rpc with tag %s",
                    player, component.netId, SpawnType[component.spawnType] || "unknown spawn type", rpc.messageTag);

            await player.room.broadcast([
                new RpcMessage(
                    component.netId,
                    new ReactorRpcMessage(
                        targetMod.netId,
                        rpc
                    )
                )
            ], undefined, [ player ]);
        }
    }

    /**
     * Send a reactor rpc from a component to a room or to a specific player.
     * @param component The component that the rpc should be sent from.
     * @param rpc The reactor rpc to send.
     * @param target Player to send
     * @returns Returns an empty promise.
     * @throws If the reactor rpc is invalid.
     */
    async sendReactorRpc(component: Networkable<unknown, NetworkableEvents, Room>, rpc: BaseReactorRpcMessage, targets?: PlayerData[]): Promise<void> {
        if (!rpc.modId)
            throw new TypeError("Bad reactor rpc: expected modId property.");

        const modConfig = this.config.mods[rpc.modId];
        if (typeof modConfig === "object") {
            if (modConfig.doNetworking === false) { // doNetworking can be undefined and is defaulted to true
                return;
            }
        }

        const promises = [];

        if (targets) {
            for (const target of targets) {
                promises.push(this._sendReactorRpc(component, rpc, target));
            }
        }

        for (const [ , player ] of component.room.players) {
            promises.push(this._sendReactorRpc(component, rpc, player));
        }

        await Promise.all(promises);
    }

    checkClientMods(connection: Connection) {
        const reactorClient = this.getReactorClient(connection);

        if (!reactorClient)
            return true;

        if (!reactorClient.expectedNumMods || reactorClient.clientMods.size < reactorClient.expectedNumMods) {
            connection.disconnect(i18n.havent_received_all_mods);
            return false;
        }

        if (!this.config.enabled) {
            connection.disconnect(i18n.reactor_not_enabled_on_server);
            return false;
        }

        const configEntries = Object.entries(this.config.mods);
        for (const [ modId, modConfig ] of configEntries) {
            const clientMod = reactorClient.clientMods.get(modId);

            if (!clientMod) {
                if (modConfig === false) {
                    return;
                }

                if (modConfig === true || !modConfig.optional) {
                    connection.disconnect(i18n.missing_required_mod,
                        modId, modConfig !== true && modConfig.version
                            ? "v" + modConfig.version : "any");
                }

                continue;
            }

            if (modConfig === false) {
                connection.disconnect(i18n.mod_banned_on_server, modId);
                return false;
            }

            if (typeof modConfig === "object") {
                if (modConfig.banned) {
                    connection.disconnect(i18n.mod_banned_on_server, modId);
                    return false;
                }

                if (modConfig.version) {
                    if (!minimatch(clientMod.modVersion, modConfig.version)) {
                        connection.disconnect(i18n.bad_mod_version,
                            modId, "v" + clientMod.modVersion, "v" + modConfig.version);
                        return false;
                    }
                }
            }
        }

        if (!this.config.allowExtraMods) {
            for (const [ , clientMod ] of reactorClient.clientMods) {
                const modConfig = this.config.mods[clientMod.modId];

                if (!modConfig) {
                    connection.disconnect(i18n.mod_not_recognised,
                        clientMod.modId);
                    return false;
                }
            }
        }

        return true;
    }

    private getReactorRpcHandlersForMessage(room: Room, reactorRpc: typeof BaseReactorRpcMessage) {
        const roomReactorRpcs = this.reactorRpcs.get(room);
        const roomReactorRpcHandlers = this.reactorRpcHandlers.get(room);

        if (!roomReactorRpcs || !roomReactorRpcHandlers)
            return [];

        const cachedHandlers = roomReactorRpcHandlers.get(reactorRpc);
        const handlers = cachedHandlers || [];
        if (!cachedHandlers) {
            roomReactorRpcs.set(`${reactorRpc.modId}:${reactorRpc.messageTag}`, reactorRpc);
            roomReactorRpcHandlers.set(reactorRpc, handlers);
        }
        return handlers;
    }

    private applyReactorRpcHandlers(room: Room) {
        const roomReactorRpcHandlers = this.reactorRpcHandlers.get(room);

        roomReactorRpcHandlers?.clear();
        for (const [, loadedPlugin] of room.workerPlugins) {
            const pluginLoadedReactorRpcHandlers = this.allPluginsLoadedReactorRpcHandlers.get(loadedPlugin.pluginInstance);

            if (!pluginLoadedReactorRpcHandlers)
                continue;

            for (const reactorRpcHandlerInfo of pluginLoadedReactorRpcHandlers) {
                this.getReactorRpcHandlersForMessage(room, reactorRpcHandlerInfo.reactorRpc)
                    .push(reactorRpcHandlerInfo.handler.bind(loadedPlugin.pluginInstance));
            }
        }

        for (const [, loadedPlugin] of room.loadedPlugins) {
            const pluginLoadedReactorRpcHandlers = this.allPluginsLoadedReactorRpcHandlers.get(loadedPlugin.pluginInstance);

            if (!pluginLoadedReactorRpcHandlers)
                continue;

            for (const reactorRpcHandlerInfo of pluginLoadedReactorRpcHandlers) {
                this.getReactorRpcHandlersForMessage(room, reactorRpcHandlerInfo.reactorRpc)
                    .push(reactorRpcHandlerInfo.handler.bind(loadedPlugin.pluginInstance));
            }
        }
    }
}

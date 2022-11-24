import {
    HindenburgPlugin,
    Room,
    MessageHandler,
    PacketContext,
    MessageHandlerCallback,
    RegisterMessage,
    PlayerSceneChangeEvent,
    SpawnType,
    SpawnFlag,
    HazelWriter,
    ComponentSpawnData,
    SceneChangeMessage,
    SpawnMessage,
    AcknowledgePacket,
    DisconnectReason,
    Language,
    ReliablePacket,
    Networkable,
    Connection,
    Worker,
    WorkerPlugin,
    ClientConnectEvent,
    MessageHandlerAttach,
    RpcMessage,
    EventListener,
    WorkerBeforeJoinEvent,
    WorkerLoadPluginEvent,
    RoomCreateEvent,
    CliCommand,
    NetworkableEvents,
    PlayerData,
    Plugin
} from "@skeldjs/hindenburg";

import { ReactorProtocolVersion } from "@skeldjs/reactor/shared";

import {
    ReactorHandshakeMessage,
    ReactorHeader,
    ReactorHelloPacket,
    ReactorSceneChangeMessage,
    ReactorSpawnMessage,
    ReactorMessage,
    BaseReactorRpcMessage,
    Rpc255Reactor,
    ModFlags,
    ModIdentifier
} from "@skeldjs/reactor/v3";

import minimatch from "minimatch";
import i18n from "./i18n";

import { getPluginReactorRpcHandlers } from "./api";
import { ClientMod } from "./ClientMod";

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

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface ReactorPluginConfig {
    /**
     * Whether or not Reactor support is enabled.
     * @default true
     */
    enabled: boolean;
    serverAsHostSyncer: boolean;
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
}

export class ReactorClient {
    clientMods: Map<string, ClientMod>;
    clientModsByNetId: ClientMod[];
    awaitingJoinRoom: number;

    constructor() {
        this.clientMods = new Map;
        this.clientModsByNetId = [];
        this.awaitingJoinRoom = 0;
    }
}

@RegisterMessage(ReactorSceneChangeMessage)
@RegisterMessage(ReactorSpawnMessage)
@RegisterMessage(ReactorHelloPacket)
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

    @MessageHandler(ReactorSceneChangeMessage, { override: true, attachTo: MessageHandlerAttach.Room })
    async onReactorSceneChangeMessage(message: ReactorSceneChangeMessage, ctx: PacketContext, _originalHandlers: MessageHandlerCallback<ReactorSceneChangeMessage>[]) {
        if (!this.config.serverAsHostSyncer || !this.config.enabled) {
            for (const handler of _originalHandlers) {
                const sceneChangeHandler = handler as unknown as MessageHandlerCallback<SceneChangeMessage>;
                await sceneChangeHandler(message.sceneChange, ctx);
            }
            return;
        }

        if (!ctx.sender)
            return;

        const room = ctx.sender.room;

        if (!room)
            return;

        const player = room.players.get(message.sceneChange.clientId);

        if (player) {
            if (message.sceneChange.scene === "OnlineGame") {
                player.inScene = true;

                const ev = await room.emit(
                    new PlayerSceneChangeEvent(
                        room,
                        player,
                        message.sceneChange
                    )
                );

                if (ev.canceled) {
                    player.inScene = false;
                } else {
                    if (room.hostIsMe) {
                        await room.broadcast(
                            room.getExistingObjectSpawn(),
                            undefined,
                            [ player ]
                        );

                        const object = room.spawnPrefabOfType(
                            SpawnType.Player,
                            player.clientId,
                            SpawnFlag.IsClientCharacter,
                            undefined,
                            false
                        );

                        if (!object)
                            return;

                        room.messageStream.push(
                            new ReactorSpawnMessage(
                                new SpawnMessage(
                                    SpawnType.Player,
                                    object.ownerId,
                                    SpawnFlag.IsClientCharacter,
                                    object.components.map((component) => {
                                        const writer = HazelWriter.alloc(512);
                                        writer.write(component, true);
                                        writer.realloc(writer.cursor);

                                        return new ComponentSpawnData(
                                            component.netId,
                                            writer.buffer
                                        );
                                    })
                                ),
                                new ReactorHeader(ReactorProtocolVersion.V3),
                                new ReactorHandshakeMessage(
                                    "Hindenburg",
                                    "1.0.0",
                                    this.worker.loadedPlugins.size
                                )
                            )
                        );

                        if (room.host && room.host.clientId !== message.sceneChange.clientId) {
                            room.host?.control?.syncSettings(room.settings);
                        }
                    }
                }
            }
        }
    }

    @MessageHandler(ReactorSpawnMessage, { override: true, attachTo: MessageHandlerAttach.Room })
    async onReactorSpawnMessage(message: ReactorSpawnMessage, ctx: PacketContext, _originalHandlers: MessageHandlerCallback<ReactorSpawnMessage>[]) {
        for (const handler of _originalHandlers) {
            const sceneChangeHandler = handler as unknown as MessageHandlerCallback<SpawnMessage>;
            await sceneChangeHandler(message.spawn, ctx);
        }
        return;
    }

    @MessageHandler(ReactorHelloPacket, { override: true })
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async onReactorHello(message: ReactorHelloPacket, { sender }: PacketContext, _originalHandlers: MessageHandlerCallback<ReactorHelloPacket>[]) {
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

        const reactorClient = this.getReactorClient(sender);
        if (reactorClient && message.handshake && message.handshake.mods) {
            let netId = 1;
            for (const mod of message.handshake.mods) {
                if ((mod.flags & ModFlags.RequireOnAllClients) !== 0) {
                    const clientMod = new ClientMod(mod.id, mod.flags, mod.version, netId);
                    reactorClient.clientMods.set(mod.id, clientMod);

                    reactorClient.clientModsByNetId[netId] = clientMod;
                    netId++;
                } else {
                    const clientMod = new ClientMod(mod.id, mod.flags, mod.version, undefined);
                    reactorClient.clientMods.set(mod.id, clientMod);
                }
            }
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

        const reactorRpcMessage = message.data as unknown as Rpc255Reactor;
        if (reactorRpcMessage.messageTag === 0xff) {
            message.cancel();

            const component = sender.room?.netobjects.get(message.netId);
            const modId = reactorRpcMessage.modId.getIdentifier();

            const reactorClient = this.getReactorClient(sender);

            if (!reactorClient)
                return;

            const senderMod = typeof modId === "string"
                ? reactorClient.clientMods.get(modId)
                : reactorClient.clientModsByNetId[modId];

            if (!component) {
                this.logger.warn("Got reactor rpc from %s for unknown component with net id %s",
                    sender, message.netId);
                return;
            }

            if (!senderMod) {
                this.logger.warn("Got reactor rpc from %s for unknown mod with id %s",
                    sender, reactorRpcMessage.modId.getIdentifier());
                return;
            }

            const roomReactorRpcs = this.reactorRpcs.get(player.room);
            const roomReactorRpcHandlers = this.reactorRpcHandlers.get(player.room);

            if (!roomReactorRpcs || !roomReactorRpcHandlers)
                return;

            const reactorRpc = roomReactorRpcs.get(`${senderMod.modId}:${reactorRpcMessage.data.messageTag}`);

            if (reactorRpc) {
                const rpcHandlers = roomReactorRpcHandlers.get(reactorRpc);
                if (rpcHandlers) {
                    for (let i = 0; i < rpcHandlers.length; i++) {
                        const handler = rpcHandlers[i];
                        handler(component, reactorRpcMessage.data);
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
                        new Rpc255Reactor(
                            new ModIdentifier(receiverMod.isNetworked() ? receiverMod.netId : undefined, receiverMod.isNetworked() ? undefined : receiverMod.modId),
                            reactorRpcMessage.data
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

        if (reactorClient) {
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
        this.allPluginsLoadedReactorRpcHandlers.set(ev.plugin, [...reactorRpcs] as any);

        if (ev.isRoomPlugin()) {
            this.applyReactorRpcHandlers(ev.room);
        }
    }

    @EventListener("room.create")
    onRoomCreate(ev: RoomCreateEvent) {
        this.applyReactorRpcHandlers(ev.room);
    }

    @CliCommand({ usage: "list mods <client id>" })
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
                    new Rpc255Reactor(
                        new ModIdentifier(targetMod.isNetworked() ? targetMod.netId : undefined, targetMod.isNetworked() ? undefined : targetMod.modId),
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

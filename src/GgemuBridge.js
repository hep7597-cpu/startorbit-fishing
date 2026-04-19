const GgemuBridge = {
    sdk: null,
    initPromise: null,
    bagState: null,
    bagEnabled: false,
    bagListeners: new Set(),
    bagCommandQueue: Promise.resolve(),
    liveListeners: new Set(),
    eventsBound: false,
    liveConfig: {
        fps: 30,
        maxFramerate: 30,
        maxBitrateKbps: 2000,
    },

    async init(config) {
        if (this.initPromise) {
            return this.initPromise;
        }

        this.initPromise = this.bootstrap(config).catch((error) => {
            console.warn('[GGEMU] init failed:', error);
            return null;
        });

        return this.initPromise;
    },

    async bootstrap(config) {
        const sdk = await this.ensureSdk();

        if (!sdk) {
            return null;
        }

        this.sdk = sdk;
        this.bindEvents();

        sdk.init({
            debug: false,
            parentOrigin: '*',
            gameId: config.gameId || 'sdk-fishcannon',
            fps: this.liveConfig.fps,
            maxFramerate: this.liveConfig.maxFramerate,
            maxBitrateKbps: this.liveConfig.maxBitrateKbps,
        });

        if (config.canvas) {
            sdk.registerCanvas(config.canvas, this.liveConfig);
        }

        if (config.audioNode) {
            sdk.registerAudioNode(config.audioNode);
        }

        sdk.setReady({
            game: config.gameId || 'sdk-fishcannon',
            engine: 'pixi-fishcannon',
        });

        await this.refreshBagState();
        this.startLive();

        return sdk;
    },

    async ensureSdk() {
        if (window.GGEMU) {
            return window.GGEMU;
        }

        const urls = this.resolveSdkUrls();

        for (const url of urls) {
            try {
                await this.loadScript(url);
                if (window.GGEMU) {
                    return window.GGEMU;
                }
            } catch (error) {
                console.warn('[GGEMU] failed to load sdk:', url, error);
            }
        }

        return null;
    },

    resolveSdkUrls() {
        const urls = [];
        const { protocol, origin, hostname } = window.location;
        const isHttp = protocol === 'http:' || protocol === 'https:';
        const isLocal = hostname === 'localhost' || hostname === '127.0.0.1';

        if (isLocal) {
            urls.push('http://localhost:3000/api/ggemu-sdk.js');
        }

        if (isHttp) {
            urls.push(`${origin}/api/ggemu-sdk.js`);
        }

        urls.push('https://ggemu.com/api/ggemu-sdk.js');

        return [...new Set(urls)];
    },

    loadScript(url) {
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = url;
            script.async = true;
            script.onload = resolve;
            script.onerror = () => reject(new Error('Failed to load GGEMU SDK.'));
            document.head.appendChild(script);
        });
    },

    bindEvents() {
        if (!this.sdk || this.eventsBound) {
            return;
        }

        this.eventsBound = true;

        this.sdk.on('ggemu:bag-updated', (payload) => {
            this.applyBagState(payload && payload.bag ? payload.bag : payload);
        });

        this.sdk.on('ggemu:error', (payload) => {
            const message = payload && payload.lastError ? payload.lastError.message : 'Unknown GGEMU error.';
            console.warn('[GGEMU]', message);
        });

        this.sdk.on('ggemu:live-started', () => {
            this.emitLiveState(true);
        });

        this.sdk.on('ggemu:live-stopped', () => {
            this.emitLiveState(false);
        });
    },

    applyBagState(nextState) {
        if (!nextState || typeof nextState !== 'object') {
            return;
        }

        this.bagState = {
            bag_count: Math.max(0, Number(nextState.bag_count || 0)),
            bag_max: Math.max(0, Number(nextState.bag_max || 0)),
            can_pickup: Boolean(nextState.can_pickup),
            can_claim: Boolean(nextState.can_claim),
        };
        this.bagEnabled = true;
        this.emitBagState();
    },

    emitBagState() {
        for (const listener of this.bagListeners) {
            listener(this.getBagState());
        }
    },

    onBagUpdate(listener) {
        if (typeof listener !== 'function') {
            return () => {};
        }

        this.bagListeners.add(listener);

        if (this.bagEnabled) {
            listener(this.getBagState());
        }

        return () => {
            this.bagListeners.delete(listener);
        };
    },

    getBagState() {
        return this.bagState ? { ...this.bagState } : null;
    },

    getBagCoins() {
        return this.bagState ? this.bagState.bag_count : 0;
    },

    isBagEnabled() {
        return this.bagEnabled;
    },

    async refreshBagState() {
        if (!this.sdk || !this.sdk.getBagStatus) {
            return null;
        }

        return this.enqueueBagCommand(async () => {
            try {
                const result = await this.sdk.getBagStatus();
                this.applyBagState(result);
                return result;
            } catch (error) {
                console.warn('[GGEMU] bag unavailable:', error && error.message ? error.message : error);
                return null;
            }
        });
    },

    async useCoins(amount) {
        if (!this.sdk || !this.sdk.useBagCoins) {
            throw new Error('GGEMU bag is unavailable.');
        }

        return this.enqueueBagCommand(async () => {
            const result = await this.sdk.useBagCoins(amount);
            this.applyBagState(result);
            return result;
        });
    },

    async addCoins(amount) {
        if (!this.sdk || !this.sdk.addBagCoins) {
            throw new Error('GGEMU bag is unavailable.');
        }

        return this.enqueueBagCommand(async () => {
            const result = await this.sdk.addBagCoins(amount);
            this.applyBagState(result);
            return result;
        });
    },

    enqueueBagCommand(task) {
        const runTask = async () => task();
        const queuedTask = this.bagCommandQueue.catch(() => null).then(runTask);

        this.bagCommandQueue = queuedTask.catch(() => null);

        return queuedTask;
    },

    emitLiveState(active) {
        for (const listener of this.liveListeners) {
            listener(Boolean(active));
        }
    },

    onLiveStateChange(listener) {
        if (typeof listener !== 'function') {
            return () => {};
        }

        this.liveListeners.add(listener);

        return () => {
            this.liveListeners.delete(listener);
        };
    },

    async startLive() {
        if (!this.sdk || !this.sdk.startLive) {
            return null;
        }

        try {
            return await this.sdk.startLive(this.liveConfig);
        } catch (error) {
            console.warn('[GGEMU] live unavailable:', error && error.message ? error.message : error);
            return null;
        }
    },
};

window.GgemuBridge = GgemuBridge;

/**
 * StarOrbitBridge.js
 * 替换 GgemuBridge，对接 Telegram Mini App SDK + StarOrbit 金币后端
 * CEO: 发达 | CTO: Hermes
 */

const StarOrbitBridge = {
    // 状态
    tgUser: null,
    coins: 0,
    isReady: false,
    commandQueue: Promise.resolve(),
    coinListeners: new Set(),
    liveListeners: new Set(),

    // 后端 API 地址（部署后替换为实际地址）
    API_BASE: window.STARORBIT_API_BASE || 'https://starorbit-api.onrender.com',

    // ── 初始化入口 ──────────────────────────────────────────────
    async init(config) {
        try {
            // 1. 拿 Telegram 用户信息
            const tg = window.Telegram?.WebApp;
            if (tg) {
                tg.ready();
                tg.expand();
                this.tgUser = tg.initDataUnsafe?.user || null;
            }

            // 2. 如果没有 Telegram 环境（本地开发），用 mock 用户
            if (!this.tgUser) {
                console.warn('[StarOrbit] Telegram WebApp 不可用，使用 mock 用户');
                this.tgUser = { id: 0, first_name: '游客', username: 'guest' };
            }

            // 3. 登录 / 注册，获取初始金币
            await this.login();

            // 4. 检查每日签到
            await this.checkDailyBonus();

            this.isReady = true;
            console.log(`[StarOrbit] 初始化完成，用户: ${this.tgUser.first_name}，金币: ${this.coins}`);
        } catch (err) {
            console.warn('[StarOrbit] 初始化失败（降级本地模式）:', err);
            this.coins = 200; // 降级：给 200 离线金币
            this.isReady = true;
        }

        this.emitCoins();
    },

    // ── 登录 / 注册 ─────────────────────────────────────────────
    async login() {
        const tg = window.Telegram?.WebApp;
        const resp = await this._fetch('/game/login', {
            method: 'POST',
            body: JSON.stringify({
                user_id: this.tgUser.id,
                username: this.tgUser.username || '',
                first_name: this.tgUser.first_name || '',
                init_data: tg?.initData || ''
            })
        });
        this.coins = resp.coins ?? 200;
    },

    // ── 每日签到 ─────────────────────────────────────────────────
    async checkDailyBonus() {
        try {
            const resp = await this._fetch('/game/daily', {
                method: 'POST',
                body: JSON.stringify({ user_id: this.tgUser.id })
            });
            if (resp.rewarded) {
                this.coins = resp.coins;
                // 显示签到弹窗
                this._showBonusToast(`🎁 每日签到 +${resp.bonus} 金币！`);
            }
        } catch (_) {
            // 静默失败
        }
    },

    // ── 金币操作 ─────────────────────────────────────────────────
    async useCoins(amount) {
        return this._enqueue(async () => {
            // 乐观更新（先扣，失败回滚）
            this.coins = Math.max(0, this.coins - amount);
            this.emitCoins();

            try {
                const resp = await this._fetch('/game/spend', {
                    method: 'POST',
                    body: JSON.stringify({ user_id: this.tgUser.id, amount })
                });
                this.coins = resp.coins;
            } catch (err) {
                // 失败回滚
                this.coins += amount;
                console.warn('[StarOrbit] useCoins 失败，已回滚:', err);
            }

            this.emitCoins();
            return { coins: this.coins };
        });
    },

    async addCoins(amount) {
        return this._enqueue(async () => {
            this.coins += amount;
            this.emitCoins();

            try {
                const resp = await this._fetch('/game/earn', {
                    method: 'POST',
                    body: JSON.stringify({ user_id: this.tgUser.id, amount })
                });
                this.coins = resp.coins;
            } catch (err) {
                console.warn('[StarOrbit] addCoins 失败:', err);
            }

            this.emitCoins();
            return { coins: this.coins };
        });
    },

    // ── 查询余额 ─────────────────────────────────────────────────
    getBagCoins() {
        return this.coins;
    },

    isBagEnabled() {
        return this.isReady;
    },

    getBagState() {
        return { bag_count: this.coins, bag_max: 99999, can_pickup: true, can_claim: true };
    },

    // ── 监听器（兼容 Player.js 的 onBagUpdate 调用）──────────────
    onBagUpdate(listener) {
        if (typeof listener !== 'function') return () => {};
        this.coinListeners.add(listener);
        if (this.isReady) listener(this.getBagState());
        return () => this.coinListeners.delete(listener);
    },

    emitCoins() {
        const state = this.getBagState();
        for (const fn of this.coinListeners) fn(state);
    },

    // ── Live 状态（兼容 Main.js 的 onLiveStateChange 调用）───────
    onLiveStateChange(listener) {
        if (typeof listener !== 'function') return () => {};
        this.liveListeners.add(listener);
        return () => this.liveListeners.delete(listener);
    },

    // ── 充值入口（跳回 Bot）──────────────────────────────────────
    openRecharge() {
        const tg = window.Telegram?.WebApp;
        if (tg) {
            tg.openTelegramLink('https://t.me/StarOrbitAI007_bot?start=recharge');
        } else {
            alert('请在 Telegram 中打开以充值');
        }
    },

    // ── 内部工具 ─────────────────────────────────────────────────
    _enqueue(task) {
        const q = this.commandQueue.catch(() => null).then(() => task());
        this.commandQueue = q.catch(() => null);
        return q;
    },

    async _fetch(path, options = {}) {
        const resp = await fetch(this.API_BASE + path, {
            ...options,
            headers: {
                'Content-Type': 'application/json',
                ...(options.headers || {})
            }
        });
        if (!resp.ok) throw new Error(`API ${path} 返回 ${resp.status}`);
        return resp.json();
    },

    _showBonusToast(msg) {
        const el = document.createElement('div');
        el.textContent = msg;
        el.style.cssText = `
            position: fixed; top: 60px; left: 50%; transform: translateX(-50%);
            background: rgba(0,0,0,0.75); color: #FFD700;
            padding: 10px 20px; border-radius: 20px;
            font-size: 16px; font-weight: bold;
            z-index: 9999; pointer-events: none;
            animation: fadeOut 3s forwards;
        `;
        document.head.insertAdjacentHTML('beforeend', `
            <style>
                @keyframes fadeOut {
                    0%   { opacity: 1; transform: translateX(-50%) translateY(0); }
                    70%  { opacity: 1; }
                    100% { opacity: 0; transform: translateX(-50%) translateY(-20px); }
                }
            </style>
        `);
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 3500);
    }
};

// 兼容原 GgemuBridge 命名，让 Main.js / Player.js 无需改动
window.GgemuBridge = StarOrbitBridge;
window.StarOrbitBridge = StarOrbitBridge;

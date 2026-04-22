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
    
    // 本地存储键
    STORAGE_KEYS: {
        COINS: 'starorbit_coins',
        USER_ID: 'starorbit_user_id',
        FIRST_TIME: 'starorbit_first_time',
        DAILY_BONUS: 'starorbit_daily_bonus',
        LAST_SESSION: 'starorbit_last_session'
    },
    
    // 游戏经济限制
    LIMITS: {
        MAX_OFFLINE_COINS: 10000, // 离线模式最大金币限制
        MIN_COINS: 0,
        INITIAL_BONUS: 200,
        DAILY_BONUS: 30
    },

    // ── 本地存储管理 ──────────────────────────────────────────────
    getLocalCoins() {
        const stored = localStorage.getItem(this.STORAGE_KEYS.COINS);
        const coins = stored ? parseInt(stored, 10) : 0;
        
        // 防作弊：限制本地金币上限
        if (coins > this.LIMITS.MAX_OFFLINE_COINS) {
            console.warn('[StarOrbit] 检测到异常金币数量，重置为上限:', this.LIMITS.MAX_OFFLINE_COINS);
            this.setLocalCoins(this.LIMITS.MAX_OFFLINE_COINS);
            return this.LIMITS.MAX_OFFLINE_COINS;
        }
        
        return Math.max(coins, this.LIMITS.MIN_COINS);
    },

    setLocalCoins(amount) {
        // 确保金币在合理范围内
        const validAmount = Math.max(this.LIMITS.MIN_COINS, Math.min(amount, this.LIMITS.MAX_OFFLINE_COINS));
        localStorage.setItem(this.STORAGE_KEYS.COINS, validAmount.toString());
        
        // 记录最后会话时间（用于异常检测）
        localStorage.setItem(this.STORAGE_KEYS.LAST_SESSION, Date.now().toString());
    },

    getStoredUserId() {
        return localStorage.getItem(this.STORAGE_KEYS.USER_ID);
    },

    setStoredUserId(userId) {
        localStorage.setItem(this.STORAGE_KEYS.USER_ID, userId.toString());
    },

    isFirstTime() {
        return !localStorage.getItem(this.STORAGE_KEYS.FIRST_TIME);
    },

    markNotFirstTime() {
        localStorage.setItem(this.STORAGE_KEYS.FIRST_TIME, 'false');
    },

    generateDeviceId() {
        // 生成基于浏览器特征的设备ID
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        ctx.textBaseline = 'top';
        ctx.font = '14px Arial';
        ctx.fillText('StarOrbit Fishing', 2, 2);
        
        const fingerprint = [
            navigator.userAgent,
            navigator.language,
            screen.width + 'x' + screen.height,
            new Date().getTimezoneOffset(),
            canvas.toDataURL()
        ].join('|');
        
        // 简单hash
        let hash = 0;
        for (let i = 0; i < fingerprint.length; i++) {
            const char = fingerprint.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // 转为32位整数
        }
        return Math.abs(hash);
    },

    detectAbnormalRestart() {
        const lastSession = localStorage.getItem(this.STORAGE_KEYS.LAST_SESSION);
        const now = Date.now();
        
        if (lastSession) {
            const timeDiff = now - parseInt(lastSession, 10);
            // 如果距离上次会话少于30秒，可能是异常重启
            if (timeDiff < 30000) {
                console.warn('[StarOrbit] 检测到频繁重启，距上次会话', timeDiff, 'ms');
                // 可以在这里添加更严格的限制，比如临时冻结账户
            }
        }
    },

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

            // 2. 如果没有 Telegram 环境（本地开发），生成设备ID用户
            if (!this.tgUser) {
                console.warn('[StarOrbit] Telegram WebApp 不可用，使用设备ID用户');
                const deviceId = this.generateDeviceId();
                this.tgUser = { 
                    id: deviceId, 
                    first_name: '游客' + (deviceId % 1000), 
                    username: 'guest_' + deviceId 
                };
                this.setStoredUserId(deviceId);
            }

            // 3. 登录 / 注册，获取初始金币
            await this.login();

            // 4. 检查每日签到
            await this.checkDailyBonus();

            this.isReady = true;
            console.log(`[StarOrbit] 初始化完成，用户: ${this.tgUser.first_name}，金币: ${this.coins}`);
        } catch (err) {
            console.warn('[StarOrbit] 初始化失败（降级本地模式）:', err);
            await this.initOfflineMode();
        }

        this.emitCoins();
    },

    async initOfflineMode() {
        console.log('[StarOrbit] 启动离线模式');
        
        // 确保有用户身份
        if (!this.tgUser) {
            const deviceId = this.generateDeviceId();
            this.tgUser = { 
                id: deviceId, 
                first_name: '游客' + (deviceId % 1000), 
                username: 'guest_' + deviceId 
            };
            this.setStoredUserId(deviceId);
        }

        // 检查是否首次使用
        if (this.isFirstTime()) {
            console.log('[StarOrbit] 离线模式：首次用户，赠送初始金币');
            this.coins = this.LIMITS.INITIAL_BONUS;
            this.markNotFirstTime();
        } else {
            // 恢复上次的金币余额
            this.coins = this.getLocalCoins();
            console.log('[StarOrbit] 离线模式：恢复金币余额', this.coins);
            
            // 异常检测：检查是否在短时间内多次重启
            this.detectAbnormalRestart();
        }

        this.isReady = true;
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
            try {
                const resp = await this._fetch('/game/spend', {
                    method: 'POST',
                    body: JSON.stringify({ user_id: this.tgUser.id, amount })
                });
                this.coins = resp.coins;
                this.emitCoins();
                return { coins: this.coins, success: true };
            } catch (err) {
                console.warn('[StarOrbit] useCoins API失败，降级本地模式:', err);
                // 降级到本地模式：直接扣除金币
                if (this.coins >= amount) {
                    this.coins -= amount;
                    this.setLocalCoins(this.coins); // 同步到本地存储
                    this.emitCoins();
                    return { coins: this.coins, success: true };
                } else {
                    console.warn('[StarOrbit] 本地金币不足:', this.coins, '<', amount);
                    this.emitCoins();
                    return { coins: this.coins, success: false };
                }
            }
        });
    },

    async addCoins(amount) {
        return this._enqueue(async () => {
            try {
                const resp = await this._fetch('/game/earn', {
                    method: 'POST',
                    body: JSON.stringify({ user_id: this.tgUser.id, amount })
                });
                this.coins = resp.coins;
            } catch (err) {
                console.warn('[StarOrbit] addCoins API失败，降级本地模式:', err);
                // 降级到本地模式：直接增加金币
                this.coins += amount;
                this.setLocalCoins(this.coins); // 同步到本地存储
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
        // 自动保存金币到本地存储
        this.setLocalCoins(this.coins);
        
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
            // 先尝试 openTelegramLink，失败则用 openLink
            try {
                tg.openTelegramLink('https://t.me/StarOrbitAI007_bot?start=recharge');
                setTimeout(() => tg.close(), 300);
            } catch (e) {
                window.open('https://t.me/StarOrbitAI007_bot?start=recharge', '_blank');
            }
        } else {
            window.open('https://t.me/StarOrbitAI007_bot?start=recharge', '_blank');
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

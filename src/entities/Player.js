class Player {
    // 炮弹等级 → 实际金币消耗映射表
    static POWER_COST = {
        1: 1,
        2: 2,
        3: 5,
        4: 10,
        5: 20,
        6: 30,
        7: 50
    };

    constructor() {
        this.container = new PIXI.Container();
        this.localCoins = 0; // 离线模式金币（不再默认给1000）
        this.pendingBagReward = 0;
        this.bullets = [];
        this._firelock = false; // 防止连射穿透

        this.cannon = new Cannon();
        this.cannon.x = Game.width / 2;
        this.cannon.y = Game.height - 10;
        this.container.addChild(this.cannon);

        this.accuracyBar = new AccuracyBar();
        this.container.addChild(this.accuracyBar);

        this.setupUI();
        this.bindBagState();
    }

    setupUI() {
        this.minusBtn = new PIXI.Sprite(ResourceManager.getTexture("bottom", [132, 72, 44, 31]));
        this.minusBtn.interactive = true;
        this.minusBtn.anchor.set(0.5);
        this.minusBtn.on('pointerdown', (e) => {
            e.stopPropagation();
            this.cannon.setPower(this.cannon.power - 1);
            this.accuracyBar.setPower(this.cannon.power);
            AudioManager.playUI();
        });

        this.plusBtn = new PIXI.Sprite(ResourceManager.getTexture("bottom", [44, 72, 44, 31]));
        this.plusBtn.interactive = true;
        this.plusBtn.anchor.set(0.5);
        this.plusBtn.on('pointerdown', (e) => {
            e.stopPropagation();
            this.cannon.setPower(this.cannon.power + 1);
            this.accuracyBar.setPower(this.cannon.power);
            AudioManager.playUI();
        });

        this.container.addChild(this.minusBtn, this.plusBtn);

        this.coinText = new PIXI.Text({
            text: this.getDisplayedCoins().toString().padStart(6, '0'),
            style: {
                fill: '#FFD700',
                fontSize: 18,
                fontWeight: 'bold',
                letterSpacing: 2,
                dropShadow: true,
                dropShadowColor: '#000000',
                dropShadowDistance: 1
            }
        });
        this.container.addChild(this.coinText);

        this.onResize(Game.width, Game.height);
    }

    onResize(width, height) {
        this.cannon.x = width / 2 + 50;
        this.cannon.y = height - 10;

        this.minusBtn.x = width / 2 - 25;
        this.minusBtn.y = height - 35;

        this.plusBtn.x = width / 2 + 125;
        this.plusBtn.y = height - 35;

        this.accuracyBar.x = width / 2 + 268;
        this.accuracyBar.y = height - 17;

        this.coinText.x = 10;
        this.coinText.y = height - 30;
    }

    bindBagState() {
        if (!window.GgemuBridge) {
            return;
        }

        GgemuBridge.onBagUpdate(() => {
            this.renderCoins();
        });

        this.renderCoins();
    }

    /** 获取当前炮弹的金币消耗 */
    getCurrentCost() {
        return Player.POWER_COST[this.cannon.power] || this.cannon.power;
    }

    getDisplayedCoins() {
        if (!window.GgemuBridge || !GgemuBridge.isBagEnabled()) {
            return this.localCoins;
        }

        return Math.max(0, GgemuBridge.getBagCoins() + this.pendingBagReward);
    }

    renderCoins() {
        this.coinText.text = this.getDisplayedCoins().toString().padStart(6, '0');
    }

    async fire(targetGlobalPos) {
        // 1. Bridge未初始化完成前禁止射击
        if (window.GgemuBridge && !GgemuBridge.isBagEnabled()) {
            return;
        }

        // 2. 防连射锁
        if (this._firelock) return;

        const cost = this.getCurrentCost();

        // 3. 余额不足检查
        if (this.getDisplayedCoins() < cost) {
            return;
        }

        // 4. 先扣后射
        this._firelock = true;

        const canFire = await this.consumeCoins(cost);
        if (!canFire) {
            this._firelock = false;
            return;
        }

        // 5. 扣费成功，发射子弹
        const dx = targetGlobalPos.x - this.cannon.x;
        const dy = targetGlobalPos.y - this.cannon.y;
        const rotation = Math.atan2(dy, dx) + Math.PI / 2;

        this.cannon.fire(rotation);

        const accuracy = this.accuracyBar.getAccuracy();
        this.accuracyBar.showFeedback(accuracy);
        const bullet = new Bullet(this.cannon.power, rotation);
        bullet.accuracyMult = accuracy;
        bullet.x = this.cannon.x;
        bullet.y = this.cannon.y;
        this.bullets.push(bullet);
        Game.app.stage.addChild(bullet);

        Game.coinsSpentSinceLastSchool = (Game.coinsSpentSinceLastSchool || 0) + cost;

        this._firelock = false;
    }

    async consumeCoins(amount) {
        // 离线模式（无Bridge或Bridge未就绪）
        if (!window.GgemuBridge || !GgemuBridge.isBagEnabled()) {
            if (this.localCoins < amount) {
                return false;
            }
            this.localCoins -= amount;
            this.renderCoins();
            return true;
        }

        // 在线模式：先调API扣费，成功后才返回true
        try {
            const result = await GgemuBridge.useCoins(amount);
            this.renderCoins();
            return result && result.success !== false;
        } catch (error) {
            console.warn('[Player] spend coins failed:', error && error.message ? error.message : error);
            this.renderCoins();
            return false;
        }
    }

    addCoin(amount) {
        if (amount <= 0) {
            return;
        }

        if (!window.GgemuBridge || !GgemuBridge.isBagEnabled()) {
            this.localCoins += amount;
            this.renderCoins();
            AudioManager.playBubble();
            return;
        }

        // 先乐观显示，等API确认
        this.pendingBagReward += amount;
        this.renderCoins();
        AudioManager.playBubble();

        GgemuBridge.addCoins(amount)
            .catch((error) => {
                console.warn('[Player] add coins failed:', error && error.message ? error.message : error);
            })
            .finally(() => {
                this.pendingBagReward = Math.max(0, this.pendingBagReward - amount);
                this.renderCoins();
            });
    }

    updateBullets(delta) {
        if (this.accuracyBar) {
            this.accuracyBar.update(delta);
        }

        for (let i = this.bullets.length - 1; i >= 0; i--) {
            const b = this.bullets[i];
            b.update(delta);
            if (b.isDead) {
                Game.app.stage.removeChild(b);
                this.bullets.splice(i, 1);
            }
        }
    }
}

class CaptureRules {
    static highPowerCap = 0.9;
    static levelPenaltyRate = 0.75;

    static getSingleCaptureChance({ bulletPower, fishCoin, fishPowerLevel }) {
        const normalizedBulletPower = Number(bulletPower || 0);
        const normalizedFishCoin = Number(fishCoin || 0);
        const normalizedFishPowerLevel = Number(fishPowerLevel || 1);

        if (normalizedBulletPower <= 0 || normalizedFishCoin <= 0) {
            return 0;
        }

        const economyChance = Math.min(1, normalizedBulletPower / normalizedFishCoin);
        const levelDelta = normalizedFishPowerLevel - normalizedBulletPower;
        const levelPenalty = levelDelta > 0
            ? Math.pow(CaptureRules.levelPenaltyRate, levelDelta)
            : 1;

        let captureChance = economyChance * levelPenalty;

        if (normalizedBulletPower > normalizedFishPowerLevel) {
            captureChance = Math.min(captureChance, CaptureRules.highPowerCap);
        }

        return Math.max(0, Math.min(1, captureChance));
    }

    static getFishCaptureChance(bulletPower, fishType = {}) {
        return CaptureRules.getSingleCaptureChance({
            bulletPower,
            fishCoin: fishType.coin,
            fishPowerLevel: fishType.powerLevel
        });
    }
}

globalThis.CaptureRules = CaptureRules;

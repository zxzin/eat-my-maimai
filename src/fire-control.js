// One press owns a firing gesture. Release after a burst never adds a tap shot.
export function createHoldFire({ holdDelay = 190 } = {}) {
  let active = false, fired = false, nextAt = Infinity;
  return {
    begin(now, { immediate = false } = {}) { active = true; fired = false; nextAt = now + (immediate ? 0 : holdDelay); },
    tick(now, interval, shoot) {
      if (!active || now < nextAt) return false;
      const accepted = shoot() === true;
      if (accepted) fired = true;
      nextAt = now + (accepted ? interval : Math.min(interval, 35));
      return accepted;
    },
    release() { const tap = active && !fired; this.cancel(); return tap; },
    cancel() { active = false; fired = false; nextAt = Infinity; },
    get active() { return active; },
  };
}

export const fireInterval = ammo => ammo === 'corn' ? 95 : ammo === 'burgerbomb' ? 800 : 420;

'use strict';
// Town hall services (市政厅): welfare donations raise goodness (善恶), the
// business counter issues/cancels the business license needed for stalls.
const DONATION_MIN = 1000;
// Stall license: 1,000,000 gold for 15 days; applying again while valid extends it.
const LICENSE_DEPOSIT = 1000000;
const LICENSE_REFUND = 0;
const LICENSE_DAYS = 15;
const LICENSE_MS = LICENSE_DAYS * 864e5;

// Licenses saved before expiry existed carry only issuedAt.
function licenseExpiresAt(ch) {
  const l = ch.businessLicense;
  if (!l) return 0;
  return l.expiresAt || (l.issuedAt || 0) + LICENSE_MS;
}
function hasLicense(ch, now = Date.now()) { return licenseExpiresAt(ch) > now; }
function fmtGold(n) { return n >= 10000 && n % 10000 === 0 ? (n / 10000) + '万' : String(n); }
function fmtDate(t) { return new Date(t).toLocaleString('zh-CN', { hour12: false, timeZone: process.env.TZ || 'Asia/Shanghai' }); }
const GOODNESS_PER_KB = 1 / 1000;
const GOODNESS_MAX = 10000;

class Townhouse {
  register(server) {
    this.server = server;
    server.on(server.op.TOWNHOUSE_SERVICE, server.requirePlayer((p, d) => this.handle(p, d || {})));
  }

  send(p, service, type, extra = {}) {
    p.send(this.server.op.TOWNHOUSE_SERVICE_EVENT, Object.assign({
      type, service, serverSeq: this.server.nextSeq(),
      gold: p.ch.gold, goodness: p.ch.alignment || 0, businessLicense: hasLicense(p.ch), businessLicenseExpiresAt: hasLicense(p.ch) ? licenseExpiresAt(p.ch) : 0,
    }, extra));
  }

  handle(p, d) {
    const service = d.service === 'business' ? 'business' : 'welfare';
    const fail = (message) => this.send(p, service, 'error', { message });
    if (!p.scene || p.scene.mapRef !== 'townhouse') return fail('请到市政厅办理。');
    switch (d.type) {
      case 'query': return this.send(p, service, 'state');
      case 'donate': {
        const amount = Number(d.amount);
        if (!Number.isSafeInteger(amount) || amount < DONATION_MIN) return fail('捐的太少了吧，呵呵');
        if (amount > p.ch.gold) return fail('您没有那么多钱。');
        p.ch.gold -= amount;
        p.ch.alignment = Math.min(GOODNESS_MAX, (p.ch.alignment || 0) + Math.floor(amount * GOODNESS_PER_KB));
        p.paramsDirty = true; p.flushParams();
        return this.send(p, service, 'result', { message: '感谢您捐献 ' + amount + ' KB，您的善良度提高了。' });
      }
      case 'business_apply':
      {
        const price = this.server.config.licensePrice == null ? LICENSE_DEPOSIT : this.server.config.licensePrice;
        const days = this.server.config.licenseDays || LICENSE_DAYS;
        if (p.ch.gold < price) return fail('领取摆摊执照需要 ' + fmtGold(price) + ' 金币（有效期 ' + days + ' 天）。');
        const now = Date.now();
        const renew = hasLicense(p.ch, now);
        const expiresAt = (renew ? licenseExpiresAt(p.ch) : now) + days * 864e5;
        p.ch.gold -= price;
        p.ch.businessLicense = { issuedAt: renew ? p.ch.businessLicense.issuedAt : now, expiresAt };
        p.paramsDirty = true; p.flushParams();
        return this.send(p, service, 'result', { message: (renew ? '摆摊执照续期成功' : '摆摊执照领取成功') + '，花费 ' + fmtGold(price) + ' 金币，有效期至 ' + fmtDate(expiresAt) + '。' + (renew ? '' : '右键点击自己选择“摆摊”即可开店。') });
      }
      case 'business_cancel':
        if (!hasLicense(p.ch)) return fail('您还没有有效的摆摊执照。');
        if (this.server.features.interaction && this.server.features.interaction.stallOf(p.id)) return fail('请先收摊再注销营业执照。');
        p.ch.businessLicense = null; p.ch.gold += LICENSE_REFUND;
        p.paramsDirty = true; p.flushParams();
        return this.send(p, service, 'result', { message: '摆摊执照已注销。' + (LICENSE_REFUND ? '退还 ' + LICENSE_REFUND + ' 金币。' : '') });
      default: return fail('暂不提供该服务。');
    }
  }
}

module.exports = { Townhouse, hasLicense, licenseExpiresAt, LICENSE_DEPOSIT, LICENSE_DAYS };

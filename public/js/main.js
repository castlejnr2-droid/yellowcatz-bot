// ─── CONFIG ────────────────────────────────────────────
const BOT_USERNAME = 'YellowCatzBot'; // Change to your bot's username
const BOT_URL = `https://t.me/${BOT_USERNAME}`;

// ─── SET BOT LINKS ─────────────────────────────────────
document.querySelectorAll('#joinBotBtn, #heroJoinBtn, #refJoinBtn, #ctaJoinBtn, #footerBotLink, .btn-nav')
  .forEach(el => { if (el) el.href = BOT_URL; });

// ─── LOAD STATS ────────────────────────────────────────
async function loadStats() {
  try {
    const res = await fetch('/api/stats');
    const { data } = await res.json();
    
    const fmt = n => {
      if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
      if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
      return Math.floor(n).toLocaleString();
    };

    const statUsers = document.getElementById('statUsers');
    const statCollected = document.getElementById('statCollected');
    const statBattles = document.getElementById('statBattles');

    if (statUsers) animateCount(statUsers, data.users, v => v.toLocaleString());
    if (statCollected) animateCount(statCollected, data.totalCollected, fmt);
    if (statBattles) animateCount(statBattles, data.totalBattles, v => v.toLocaleString());
  } catch (e) {
    // Silently fail if backend not running
  }
}

function animateCount(el, target, formatter) {
  const duration = 1500;
  const start = performance.now();
  const from = 0;
  
  function update(now) {
    const elapsed = now - start;
    const progress = Math.min(elapsed / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    const value = from + (target - from) * eased;
    el.textContent = formatter(value);
    if (progress < 1) requestAnimationFrame(update);
  }
  requestAnimationFrame(update);
}

// ─── LOAD LEADERBOARD PREVIEW ──────────────────────────
async function loadLeaderboardPreview() {
  const container = document.getElementById('lbPreview');
  if (!container) return;
  
  try {
    const res = await fetch('/api/leaderboard');
    const { data } = await res.json();
    const collectors = data.collectors.slice(0, 5);
    
    if (!collectors.length) {
      container.innerHTML = '<div class="lb-loading">No data yet — be the first to collect!</div>';
      return;
    }

    container.innerHTML = collectors.map((u, i) => {
      const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];
      const name = u.username ? `@${u.username}` : u.first_name || 'Anonymous';
      const amount = Number(u.total_collected || 0);
      return `
        <div class="lb-row">
          <div class="lb-rank">${medals[i]}</div>
          <div class="lb-name">${escHtml(name)}</div>
          <div class="lb-amount">${fmtNum(amount)} $YellowCatz</div>
        </div>
      `;
    }).join('');
  } catch {
    container.innerHTML = '<div class="lb-loading">Could not load leaderboard.</div>';
  }
}

// ─── SCROLL ANIMATIONS ─────────────────────────────────
const observerOptions = { threshold: 0.1, rootMargin: '0px 0px -50px 0px' };
const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.style.opacity = '1';
      entry.target.style.transform = 'translateY(0)';
    }
  });
}, observerOptions);

document.querySelectorAll('.step-card, .token-feat, .ref-card').forEach(el => {
  el.style.opacity = '0';
  el.style.transform = 'translateY(20px)';
  el.style.transition = 'opacity 0.5s ease, transform 0.5s ease';
  observer.observe(el);
});

// ─── UTILS ─────────────────────────────────────────────
function escHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

function fmtNum(n) {
  n = Number(n) || 0;
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

// ─── INIT ───────────────────────────────────────────────
loadStats();
loadLeaderboardPreview();

const { getBattleById, cancelBattleWithRefund } = require('../../db/queries');

const isAdmin = (userId) => {
  const admins = process.env.ADMIN_TELEGRAM_IDS 
    ? process.env.ADMIN_TELEGRAM_IDS.split(',').map(id => String(id).trim()) 
    : [];
  return admins.includes(String(userId));
};

const adminCancelBattleCommand = async (ctx) => {
  const args = ctx.message.text.trim().split(/\s+/);
  const battleId = parseInt(args[1]);

  if (!battleId) {
    return ctx.reply(
      '❌ Usage: `/admincancelbattle <battle_id>`\n\n' +
      'Example: `/admincancelbattle 123`'
    );
  }

  const userId = ctx.from.id;

  if (!isAdmin(userId)) {
    return ctx.reply('❌ This command is for admins only.');
  }

  try {
    // Get the battle
    const battle = await getBattleById(battleId);   // using your existing getBattleById

    if (!battle) {
      return ctx.reply(`❌ Battle #${battleId} not found.`);
    }

    if (battle.status !== 'open') {
      return ctx.reply(`❌ Battle #${battleId} cannot be cancelled. Current status: ${battle.status}`);
    }

    // Cancel with refund
    const success = await cancelBattleWithRefund(battleId, `admin:${userId}`);

    if (success) {
      await ctx.reply(
        `✅ Admin cancelled battle #${battleId}\n` +
        `Host: ${battle.challenger_id}\n` +
        `Amount refunded: ${battle.wager_amount}`
      );
    } else {
      await ctx.reply(`❌ Failed to cancel battle #${battleId}`);
    }
  } catch (error) {
    console.error('[AdminCancelBattle] Error:', error);
    await ctx.reply('❌ An error occurred while cancelling the battle.');
  }
};

module.exports = { adminCancelBattleCommand };

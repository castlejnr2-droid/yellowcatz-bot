const { getPendingBattleByHost, cancelBattleWithRefund } = require('../../db/queries');

const cancelBattleCommand = async (ctx) => {
  const telegramId = ctx.from.id;
  const username = ctx.from.username || ctx.from.first_name;

  try {
    // Get the user's open battle
    const battle = await getPendingBattleByHost(telegramId);

    if (!battle) {
      return ctx.reply("❌ You don't have any open PvP battle to cancel.");
    }

    // Check if it's been more than 30 minutes
    const createdAt = new Date(battle.created_at);
    const minutesElapsed = (Date.now() - createdAt.getTime()) / (1000 * 60);

    if (minutesElapsed < 30) {
      return ctx.reply(`⏳ You can only cancel your battle after 30 minutes.\n\nThis battle has been open for ${Math.floor(minutesElapsed)} minutes.`);
    }

    // Cancel and refund
    const success = await cancelBattleWithRefund(battle.id, `host:${telegramId}`);

    if (success) {
      await ctx.reply(`✅ Your PvP battle #${battle.id} has been cancelled successfully.\nThe wager amount has been refunded to your gamble balance.`);
    } else {
      await ctx.reply("❌ Failed to cancel the battle. It might already be cancelled or accepted.");
    }
  } catch (error) {
    console.error('[CancelBattle] Error:', error);
    await ctx.reply("❌ An error occurred while cancelling your battle. Please try again later.");
  }
};

module.exports = { cancelBattleCommand };

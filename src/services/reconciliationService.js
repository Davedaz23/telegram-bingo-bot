// services/reconciliationService.js
const GameService = require('./gameService');

class ReconciliationService {
  static async runDailyReconciliation() {
    try {
      console.log('🔄 Running daily game reconciliation...');
      
      const result = await GameService.reconcileAllGames();
      
      // Also check for orphaned transactions
      await this.checkOrphanedTransactions();
      
      // Generate daily report
      const report = await this.generateDailyReport();
      
      console.log('✅ Daily reconciliation completed');
      
      return {
        reconciliation: result,
        report
      };
    } catch (error) {
      console.error('❌ Daily reconciliation failed:', error);
      throw error;
    }
  }
  
  static async checkOrphanedTransactions() {
    try {
      // Find transactions without reconciliation entries
      const Transaction = require('../models/Transaction');
      const Game = require('../models/Game');
      
      const orphanedTransactions = await Transaction.aggregate([
        {
          $match: {
            gameId: { $exists: true, $ne: null },
            type: { $in: ['GAME_ENTRY', 'WINNING'] }
          }
        },
        {
          $lookup: {
            from: 'games',
            localField: 'gameId',
            foreignField: '_id',
            as: 'game'
          }
        },
        {
          $match: {
            game: { $size: 0 } // No associated game found
          }
        }
      ]);
      
      if (orphanedTransactions.length > 0) {
        console.warn(`⚠️ Found ${orphanedTransactions.length} orphaned transactions`);
        // You could implement recovery logic here
      }
      
      return orphanedTransactions.length;
    } catch (error) {
      console.error('❌ Error checking orphaned transactions:', error);
      return 0;
    }
  }
  
  static async generateDailyReport() {
    try {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      
      const endOfDay = new Date();
      endOfDay.setHours(23, 59, 59, 999);
      
      const Game = require('../models/Game');
      const Reconciliation = require('../models/Reconciliation');
      const Wallet = require('../models/Wallet');
      
      const gamesToday = await Game.countDocuments({
        startedAt: { $gte: startOfDay, $lte: endOfDay }
      });
      
      const finishedGames = await Game.countDocuments({
        endedAt: { $gte: startOfDay, $lte: endOfDay },
        status: { $in: ['FINISHED', 'NO_WINNER'] }
      });
      
      const reconciliations = await Reconciliation.countDocuments({
        completedAt: { $gte: startOfDay, $lte: endOfDay }
      });
      
      const totalPot = await Reconciliation.aggregate([
        {
          $match: {
            completedAt: { $gte: startOfDay, $lte: endOfDay }
          }
        },
        {
          $group: {
            _id: null,
            totalPot: { $sum: '$totalPot' },
            totalWinnings: { $sum: '$winnerAmount' },
            totalRefunds: {
              $sum: {
                $cond: [{ $eq: ['$status', 'NO_WINNER_REFUNDED'] }, '$totalPot', 0]
              }
            }
          }
        }
      ]);
      
      return {
        date: startOfDay.toISOString().split('T')[0],
        gamesToday,
        finishedGames,
        reconciliations,
        financials: totalPot[0] || {
          totalPot: 0,
          totalWinnings: 0,
          totalRefunds: 0
        },
        generatedAt: new Date()
      };
    } catch (error) {
      console.error('❌ Error generating daily report:', error);
      throw error;
    }
  }
}

module.exports = ReconciliationService;
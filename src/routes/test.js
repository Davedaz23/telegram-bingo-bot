// routes/test.js - SMS Testing API
const express = require('express');
const router = express.Router();
const WalletService = require('../services/walletService');

// Test SMS extraction endpoint
router.post('/test-sms-extraction', async (req, res) => {
  try {
    const { sms } = req.body;
    
    if (!sms) {
      return res.status(400).json({ error: 'SMS text is required' });
    }

    const result = {
      originalSMS: sms,
      analysis: WalletService.analyzeSMSType(sms),
      identifiers: WalletService.extractTransactionIdentifiers(sms),
      amount: WalletService.extractAmountFromSMS(sms),
      paymentMethod: WalletService.detectPaymentMethodFromSMS(sms),
      patternMatches: {}
    };

    // Test all patterns
    const patterns = [
      { name: 'ft12', pattern: /(FT\d{6}[A-Z]{4})/i, description: 'FT + 6 digits + 4 letters' },
      { name: 'ftVar', pattern: /(FT\d{6,8}[A-Z]{2,5})/i, description: 'FT + 6-8 digits + 2-5 letters' },
      { name: 'urlId', pattern: /id=(FT\d+[A-Z]+)/i, description: 'URL id parameter' },
      { name: 'refNo', pattern: /Ref\s*No\s*([A-Z0-9]+)/i, description: 'Ref No pattern' },
      { name: 'anyFT', pattern: /(FT\d+[A-Z]+)/i, description: 'Any FT pattern' },
      { name: 'urlPattern', pattern: /apps\.cbe\.com\.et(?::\d+)?\/\?id=([A-Z0-9]+)/i, description: 'Full CBE URL' }
    ];

    patterns.forEach(p => {
      const match = sms.match(p.pattern);
      result.patternMatches[p.name] = {
        description: p.description,
        matched: !!match,
        value: match ? match[1] || match[0] : null
      };
    });

    // Clean reference if exists
    if (result.identifiers.refNumber) {
      result.cleanedReference = WalletService.cleanCBEReference(result.identifiers.refNumber);
    }

    res.json({
      success: true,
      data: result,
      summary: {
        hasReference: !!result.identifiers.refNumber,
        isCredit: result.identifiers.isCredit,
        isDebit: result.identifiers.isDebit,
        amountValid: result.amount > 0,
        bankDetected: result.identifiers.smsBank !== 'UNKNOWN'
      }
    });

  } catch (error) {
    console.error('Test SMS error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Test SMS matching endpoint
router.post('/test-sms-matching', async (req, res) => {
  try {
    const { senderSMS, receiverSMS } = req.body;
    
    if (!senderSMS || !receiverSMS) {
      return res.status(400).json({ error: 'Both senderSMS and receiverSMS are required' });
    }

    const senderIdentifiers = WalletService.extractTransactionIdentifiers(senderSMS);
    const receiverIdentifiers = WalletService.extractTransactionIdentifiers(receiverSMS);

    // Create mock SMS deposit objects for testing
    const mockSenderDeposit = {
      originalSMS: senderSMS,
      extractedAmount: senderIdentifiers.amount,
      extractedReference: senderIdentifiers.refNumber,
      createdAt: new Date(),
      paymentMethod: WalletService.detectPaymentMethodFromSMS(senderSMS),
      metadata: {
        transactionIdentifiers: senderIdentifiers,
        refNumber: senderIdentifiers.refNumber
      }
    };

    const mockReceiverDeposit = {
      originalSMS: receiverSMS,
      extractedAmount: receiverIdentifiers.amount,
      extractedReference: receiverIdentifiers.refNumber,
      createdAt: new Date(),
      paymentMethod: WalletService.detectPaymentMethodFromSMS(receiverSMS),
      metadata: {
        transactionIdentifiers: receiverIdentifiers,
        refNumber: receiverIdentifiers.refNumber
      }
    };

    // Calculate match scores
    const score1 = WalletService.calculateSMSMatchScore(senderIdentifiers, mockReceiverDeposit);
    const score2 = WalletService.calculateSMSMatchScore(receiverIdentifiers, mockSenderDeposit);

    res.json({
      success: true,
      data: {
        sender: {
          identifiers: senderIdentifiers,
          type: WalletService.analyzeSMSType(senderSMS)
        },
        receiver: {
          identifiers: receiverIdentifiers,
          type: WalletService.analyzeSMSType(receiverSMS)
        },
        matching: {
          senderToReceiverScore: score1,
          receiverToSenderScore: score2,
          shouldMatch: score1 >= 0.85 || score2 >= 0.85,
          matchThreshold: 0.85
        },
        analysis: {
          amountsMatch: senderIdentifiers.amount === receiverIdentifiers.amount,
          referencesMatch: senderIdentifiers.refNumber === receiverIdentifiers.refNumber,
          areOppositeTypes: (senderIdentifiers.isDebit && receiverIdentifiers.isCredit) || 
                           (senderIdentifiers.isCredit && receiverIdentifiers.isDebit)
        }
      }
    });

  } catch (error) {
    console.error('Test matching error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Batch test endpoint
router.post('/batch-test', async (req, res) => {
  try {
    const { testCases } = req.body;
    
    if (!Array.isArray(testCases)) {
      return res.status(400).json({ error: 'testCases must be an array' });
    }

    const results = testCases.map(testCase => {
      try {
        const identifiers = WalletService.extractTransactionIdentifiers(testCase.sms);
        return {
          name: testCase.name,
          smsPreview: testCase.sms.substring(0, 100) + '...',
          success: true,
          extracted: {
            refNumber: identifiers.refNumber,
            amount: identifiers.amount,
            type: identifiers.isCredit ? 'CREDIT' : identifiers.isDebit ? 'DEBIT' : 'UNKNOWN',
            bank: identifiers.smsBank,
            hasReference: !!identifiers.refNumber
          },
          expected: testCase.expectedRef,
          match: identifiers.refNumber === testCase.expectedRef ? '✓' : '✗'
        };
      } catch (error) {
        return {
          name: testCase.name,
          smsPreview: testCase.sms.substring(0, 100) + '...',
          success: false,
          error: error.message
        };
      }
    });

    const passed = results.filter(r => r.success && r.match === '✓').length;
    const failed = results.filter(r => !r.success || r.match === '✗').length;

    res.json({
      summary: {
        total: results.length,
        passed,
        failed,
        successRate: `${((passed / results.length) * 100).toFixed(1)}%`
      },
      results
    });

  } catch (error) {
    console.error('Batch test error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
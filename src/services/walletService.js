    // services/walletService.js - SIMPLIFIED SMS PROCESSING
    const mongoose = require('mongoose');
    const Wallet = require('../models/Wallet');
    const Transaction = require('../models/Transaction');
    const User = require('../models/User');
    const PaymentMethod = require('../models/PaymentMethod');
    const SMSDeposit = require('../models/SMSDeposit');
    const PaymentRecord = require('../models/PaymentRecord');

    class WalletService {
      
    // Update the resolveUserId method to handle both MongoDB ObjectIds and Telegram IDs
    static async resolveUserId(userId) {
      try {
        console.log('🔄 Resolving user ID:', userId, 'Type:', typeof userId);
        
        // If input is already a valid MongoDB ObjectId, return it
        if (mongoose.Types.ObjectId.isValid(userId)) {
          // Check if it's properly formatted
          const asObjectId = new mongoose.Types.ObjectId(userId);
          if (asObjectId.toString() === userId.toString()) {
            console.log('✅ Input is already MongoDB ObjectId');
            return userId;
          }
        }
        
        // Otherwise, treat it as a Telegram ID string
        console.log('🔍 Looking for user with Telegram ID:', userId.toString());
        const user = await User.findOne({ telegramId: userId.toString() });
        
        if (!user) {
          console.error('❌ User not found for Telegram ID:', userId);
          
          // NEW: Try one more check - maybe it's a username?
          const userByUsername = await User.findOne({ username: userId.toString() });
          if (userByUsername) {
            console.log(`✅ Found user by username: ${userId} -> ${userByUsername._id}`);
            return userByUsername._id;
          }
          
          throw new Error(`User not found for ID: ${userId}`);
        }
        
        console.log(`✅ Resolved Telegram ID ${userId} to MongoDB ID ${user._id}`);
        return user._id;
        
      } catch (error) {
        console.error('❌ Error resolving user ID:', error);
        throw error;
      }
    }


    // NEW: Get specific SMS deposit by ID with proper population
      static async getSMSDepositById(smsDepositId) {
        try {
          return await SMSDeposit.findById(smsDepositId)
            .populate('userId', 'firstName username telegramId')
            .populate('processedBy', 'firstName username');
        } catch (error) {
          console.error('❌ Error getting SMS deposit by ID:', error);
          throw error;
        }
      }
      // Add these new methods to your WalletService class:
    // FIXED: matchAndAutoApproveSMS with immediate approval for high-confidence matches
static async matchAndAutoApproveSMS(smsText, telegramId, paymentMethod) {
    try {
        console.log('🔄 Starting SMS matching and auto-approval...');
        console.log('🔍 SMS Details:', { telegramId, paymentMethod, smsText: smsText.substring(0, 100) });
        
        // Step 1: Analyze the SMS FIRST
        const analysis = this.analyzeSMSType(smsText);
        const identifiers = this.extractTransactionIdentifiers(smsText);
        
        console.log('📊 SMS Analysis:', {
            type: analysis.type,
            bank: analysis.bank || identifiers.smsBank,
            confidence: analysis.confidence,
            amount: identifiers.amount || identifiers.exactAmount,
            reference: identifiers.cleanRefNumber || identifiers.refNumber,
            transactionId: identifiers.transactionId
        });
        
        // Step 2: CRITICAL CHECK - See if this transaction already exists
        const transactionId = identifiers.transactionId || identifiers.cleanRefNumber || identifiers.refNumber;
        const amount = identifiers.amount || identifiers.exactAmount || this.extractAmountFromSMSCBE(smsText);
        
        if (transactionId) {
            console.log(`🔍 Checking if transaction ${transactionId} already exists...`);
            
            // Check if ANY SMS with this transaction ID is already processed
            const existingProcessedSMS = await SMSDeposit.findOne({
                $or: [
                    { extractedReference: transactionId },
                    { 'metadata.transactionId': transactionId },
                    { 'metadata.cleanReference': transactionId }
                ],
                status: { $in: ['AUTO_APPROVED', 'APPROVED', 'CONFIRMED'] }
            });
            
            if (existingProcessedSMS) {
                console.log(`❌ Transaction ${transactionId} already processed! Skipping duplicate.`);
                console.log(`📊 Existing SMS: ${existingProcessedSMS._id}, Status: ${existingProcessedSMS.status}, Type: ${existingProcessedSMS.smsType}`);
                
                // Store the SMS but mark as duplicate
                const smsDeposit = await this.storeSMSMessage(telegramId, smsText, paymentMethod);
                smsDeposit.status = 'DUPLICATE';
                smsDeposit.metadata.duplicateOf = existingProcessedSMS._id;
                smsDeposit.metadata.duplicateReason = 'Same transaction ID already processed';
                await smsDeposit.save();
                
                return {
                    status: 'DUPLICATE',
                    extractedAmount: amount,
                    transactionId: transactionId,
                    duplicateOf: existingProcessedSMS._id,
                    message: 'This transaction has already been processed'
                };
            }
        }
        
        // Step 3: BEFORE storing, check for existing matches
        const reference = identifiers.cleanRefNumber || identifiers.refNumber;
        
        if (amount && reference) {
            console.log(`🔍 Checking for existing matches BEFORE storing...`);
            console.log(`   Amount: ${amount}, Reference: ${reference}`);
            
            // Look for opposite type SMS with same reference AND amount
            const oppositeType = analysis.type === 'SENDER' ? 'RECEIVER' : 'SENDER';
            
            // FIX: Only look for SMS that are NOT already matched/approved
            const existingMatchQuery = {
                status: { $in: ['RECEIVED', 'RECEIVED_WAITING_MATCH', 'PENDING'] },
                // FIX: Exclude already processed SMS
                transactionId: { $exists: false },
                autoApproved: { $ne: true },
                // FIX: Ensure it's not already matched
                'metadata.matched': { $ne: true },
                smsType: oppositeType,
                extractedAmount: amount,
                $or: [
                    { extractedReference: reference },
                    { 'metadata.cleanReference': reference },
                    { 'metadata.rawReference': reference }
                ],
                createdAt: { $gte: new Date(Date.now() - 60 * 60 * 1000) } // Last 1 hour
            };
            
            console.log('🔍 Existing match query:', JSON.stringify(existingMatchQuery, null, 2));
            
            const existingMatches = await SMSDeposit.find(existingMatchQuery)
                .populate('userId', 'firstName username telegramId')
                .sort({ createdAt: -1 })
                .limit(5);
            
            console.log(`🔍 Found ${existingMatches.length} existing matches to check`);
            
            // Check each potential match for high confidence
            for (const existingMatch of existingMatches) {
                // FIX: Additional check - see if this match is already paired with someone else
                if (existingMatch.metadata?.matchedWith) {
                    console.log(`⚠️ Skipping ${existingMatch._id} - already matched with ${existingMatch.metadata.matchedWith}`);
                    continue;
                }
                
                const matchScore = this.calculateCBE_MatchScore(identifiers, existingMatch);
                console.log(`📊 Match score with ${existingMatch._id}: ${matchScore}`);
                
                if (matchScore >= 0.85) { // High confidence match!
                    console.log(`✅ HIGH CONFIDENCE MATCH FOUND (${matchScore}) - APPROVING IMMEDIATELY!`);
                    
                    // Step 4: Store the new SMS first
                    const newSMSDeposit = await this.storeSMSMessage(telegramId, smsText, paymentMethod);
                    
                    // Step 5: Determine which is user SMS (SENDER) and which is admin SMS (RECEIVER)
                    let userSMS, adminSMS;
                    if (analysis.type === 'SENDER') {
                        userSMS = newSMSDeposit;
                        adminSMS = existingMatch;
                    } else {
                        userSMS = existingMatch;
                        adminSMS = newSMSDeposit;
                    }
                    
                    // Step 6: Use adminForceMatchSMS to approve the match (or approveMatchedSMS)
                    try {
                        // Since we're in an automated process, we can use SYSTEM as admin
                        const result = await this.approveMatchedSMS(userSMS, adminSMS);
                        
                        console.log(`✅ Transaction auto-approved! $${amount} deposited to user ${userSMS.userId?.telegramId || userSMS.telegramId}'s wallet`);
                        
                        return {
                            status: 'APPROVED',
                            extractedAmount: amount,
                            transaction: result.transaction,
                            wallet: result.wallet,
                            user: result.user || userSMS.userId,
                            autoApproved: true,
                            type: 'IMMEDIATE_MATCH',
                            matchScore: matchScore,
                            matchedWith: existingMatch._id
                        };
                        
                    } catch (approvalError) {
                        console.error('❌ Error auto-approving high-confidence match:', approvalError);
                        // Continue to regular processing
                    }
                }
            }
        }
        
        // Step 6: If no high-confidence match found, proceed with regular processing
       // Step 7: If no high-confidence match found, proceed with regular processing
        console.log('ℹ️ No high-confidence match found, proceeding with regular processing...');
        
        // Store the SMS
        const smsDeposit = await this.storeSMSMessage(telegramId, smsText, paymentMethod);
        
        // Update with analysis results
        smsDeposit.smsType = analysis.type;
        smsDeposit.metadata.bank = analysis.bank || identifiers.smsBank;
        
        // AUTO-APPROVE LOGIC FOR TELEBIRR
        if (identifiers.smsBank === 'Telebirr' || paymentMethod === 'Telebirr') {
            console.log('📱 Processing Telebirr SMS with CBE-like matching');
            
            smsDeposit.paymentMethod = 'Telebirr';
            
            // Store SMS type
            smsDeposit.smsType = analysis.type;
            smsDeposit.metadata.bank = 'Telebirr';
            
            // Store reference if available
            if (identifiers.refNumber && !smsDeposit.extractedReference) {
                smsDeposit.extractedReference = identifiers.refNumber;
                console.log(`💾 Saved Telebirr reference: ${identifiers.refNumber}`);
            }
            
            // Try Telebirr matching similar to CBE
            const telebirrMatchResult = await this.matchTelebirrSMS(smsDeposit, smsText);
            if (telebirrMatchResult && telebirrMatchResult.autoApproved) {
                console.log('✅ Telebirr SMS matched and auto-approved!');
                return {
                    status: 'APPROVED',
                    extractedAmount: telebirrMatchResult.amount,
                    transaction: telebirrMatchResult.transaction,
                    wallet: telebirrMatchResult.wallet,
                    user: telebirrMatchResult.user,
                    autoApproved: true,
                    type: 'TELEBIRR_AUTO',
                    telebirrReference: telebirrMatchResult.telebirrReference,
                    direction: 'USER_DEPOSIT'
                };
            }
            
            // If no immediate match, save and wait
            smsDeposit.status = 'RECEIVED_WAITING_MATCH';
            smsDeposit.metadata.isUserSMS = (analysis.type === 'SENDER');
            smsDeposit.metadata.isAdminSMS = (analysis.type === 'RECEIVER');
            await smsDeposit.save();
            
            return {
                status: 'RECEIVED_WAITING_MATCH',
                extractedAmount: smsDeposit.extractedAmount,
                extractedReference: smsDeposit.extractedReference,
                type: 'TELEBIRR_WAITING',
                direction: analysis.type === 'SENDER' ? 'USER_SMS' : 'ADMIN_SMS'
            };
        }
        
        // CBE PROCESSING - Try to match with existing CBE SMS
        if (analysis.bank === 'CBE' || identifiers.smsBank === 'CBE' || paymentMethod === 'CBE Bank') {
            console.log('🏦 Processing CBE SMS with enhanced matching');
            
            smsDeposit.paymentMethod = 'CBE Bank';
            smsDeposit.metadata.bank = 'CBE';
            smsDeposit.metadata.cleanReference = identifiers.cleanRefNumber;
            
            // Try CBE matching
            const cbeMatchResult = await this.matchCBE_SMS(smsDeposit, smsText);
            if (cbeMatchResult && cbeMatchResult.autoApproved) {
                console.log('✅ CBE SMS matched and auto-approved!');
                return {
                    status: 'APPROVED',
                    extractedAmount: cbeMatchResult.amount,
                    transaction: cbeMatchResult.transaction,
                    wallet: cbeMatchResult.wallet,
                    user: cbeMatchResult.user,
                    autoApproved: true,
                    type: 'CBE_AUTO',
                    cbeReference: cbeMatchResult.cbeReference,
                    direction: 'USER_DEPOSIT'
                };
            }
            
            smsDeposit.status = 'RECEIVED_WAITING_MATCH';
            smsDeposit.metadata.isUserSMS = (analysis.type === 'SENDER');
            smsDeposit.metadata.isAdminSMS = (analysis.type === 'RECEIVER');
            await smsDeposit.save();
            
            return {
                status: 'RECEIVED_WAITING_MATCH',
                extractedAmount: smsDeposit.extractedAmount,
                extractedReference: smsDeposit.extractedReference,
                type: 'CBE_WAITING',
                direction: analysis.type === 'SENDER' ? 'USER_SMS' : 'ADMIN_SMS'
            };
        }
        
        // OTHER BANKS PROCESSING
        console.log('🏦 Processing other bank SMS');
        
        // Mark user/admin status
         smsDeposit.metadata.isUserSMS = (analysis.type === 'SENDER');
        smsDeposit.metadata.isAdminSMS = (analysis.type === 'RECEIVER');
        
        // Try auto-matching for other banks
        const matchResult = await this.tryAutoMatchSMS(smsDeposit, smsText);
        if (matchResult && matchResult.autoApproved) {
            return {
                status: 'APPROVED',
                extractedAmount: matchResult.transaction.amount,
                transaction: matchResult.transaction,
                wallet: matchResult.wallet,
                user: matchResult.userSMS.userId,
                autoApproved: true,
                type: 'OTHER_AUTO',
                direction: 'USER_DEPOSIT'
            };
        }
        
        smsDeposit.status = 'RECEIVED_WAITING_MATCH';
        await smsDeposit.save();
        
        return {
            status: 'RECEIVED_WAITING_MATCH',
            extractedAmount: smsDeposit.extractedAmount,
            extractedReference: smsDeposit.extractedReference,
            type: 'OTHER_WAITING',
            direction: analysis.type === 'SENDER' ? 'USER_SMS' : 'ADMIN_SMS'
        };
        
    } catch (error) {
        console.error('❌ Error in SMS matching (enhanced):', error);
        
        // Fallback: try to store basic SMS
        try {
            const fallbackSMS = await this.storeSMSMessage(telegramId, smsText, paymentMethod);
            fallbackSMS.status = 'RECEIVED';
            fallbackSMS.metadata.matchingError = error.message;
            await fallbackSMS.save();
            
            return {
                status: 'RECEIVED',
                extractedAmount: fallbackSMS.extractedAmount,
                extractedReference: fallbackSMS.extractedReference,
                type: 'ERROR_FALLBACK'
            };
        } catch (saveError) {
            console.error('❌ Could not save SMS deposit after error:', saveError);
            throw error;
        }
    }
}
   static async matchCBE_SMS(newSMSDeposit, smsText) {
    try {
        const newAnalysis = this.analyzeSMSType(smsText);
        const newIdentifiers = this.extractTransactionIdentifiers(smsText);
        
        console.log('🔍 CBE SMS Matching Process - AGGRESSIVE MATCHING');
        console.log('SMS Type:', newAnalysis.type);
        console.log('SMS isCredit:', newIdentifiers.isCredit);
        console.log('SMS isDebit:', newIdentifiers.isDebit);
        console.log('Amount:', newSMSDeposit.extractedAmount);
        console.log('Reference:', newSMSDeposit.extractedReference);
        console.log('Clean Reference:', newIdentifiers.cleanRefNumber);
        
        if (!newSMSDeposit.extractedAmount || newSMSDeposit.extractedAmount <= 0) {
            console.log('⚠️ No valid amount, cannot match CBE SMS');
            return null;
        }
        
        // Store SMS type and identifiers
        newSMSDeposit.smsType = newAnalysis.type;
        newSMSDeposit.metadata.transactionIdentifiers = newIdentifiers;
        
        // CRITICAL: Check if we have a reference - if not, extract and save it
        if (!newSMSDeposit.extractedReference && newIdentifiers.cleanRefNumber) {
            newSMSDeposit.extractedReference = newIdentifiers.cleanRefNumber;
            console.log(`💾 Saved reference: ${newIdentifiers.cleanRefNumber}`);
        }
        
        // Save the SMS with updated info
        await newSMSDeposit.save();
        
        // AGGRESSIVE MATCHING: Look for any opposite type SMS with same reference AND amount
        const oppositeType = newAnalysis.type === 'SENDER' ? 'RECEIVER' : 'SENDER';
        
        console.log(`🔍 Looking for ${oppositeType} SMS to match...`);
        
        // Build a VERY SIMPLE query for matching - FIXED to exclude processed SMS
        const query = {
            _id: { $ne: newSMSDeposit._id },
            status: { $in: ['RECEIVED', 'RECEIVED_WAITING_MATCH', 'PENDING'] },
            // FIX: Exclude already processed SMS
            $or: [
                { transactionId: { $exists: false } },
                { transactionId: null }
            ],
            autoApproved: { $ne: true },
            'metadata.matched': { $ne: true },
            smsType: oppositeType,
            extractedAmount: newSMSDeposit.extractedAmount,
            paymentMethod: { $regex: /CBE/i },
            createdAt: { 
                $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) // Last 24 hours
            }
        };
        
        // If we have a reference, use it
        if (newSMSDeposit.extractedReference) {
            query.extractedReference = newSMSDeposit.extractedReference;
            console.log(`🔑 Matching by exact reference: ${newSMSDeposit.extractedReference}`);
        } else if (newIdentifiers.refNumber) {
            // Try with raw reference
            query.$or = [
                { extractedReference: newIdentifiers.refNumber },
                { 'metadata.refNumber': newIdentifiers.refNumber },
                { 'metadata.rawRefNumber': newIdentifiers.refNumber }
            ];
            console.log(`🔑 Matching by raw reference: ${newIdentifiers.refNumber}`);
        }
        
        console.log('🔍 Query for matching:', JSON.stringify(query, null, 2));
        
        const potentialMatches = await SMSDeposit.find(query)
            .populate('userId', 'firstName username telegramId')
            .sort({ createdAt: -1 })
            .limit(10);
        
        console.log(`🔍 Found ${potentialMatches.length} potential CBE matches`);
        
        // SIMPLIFIED MATCHING: Just check if we have any match with same reference and amount
        if (potentialMatches.length > 0) {
            console.log('✅ Found potential matches! Checking each one...');
            
            for (const potentialMatch of potentialMatches) {
                console.log(`🔍 Checking match ${potentialMatch._id}:`);
                console.log(`   Type: ${potentialMatch.smsType}`);
                console.log(`   Amount: ${potentialMatch.extractedAmount}`);
                console.log(`   Ref: ${potentialMatch.extractedReference}`);
                console.log(`   Status: ${potentialMatch.status}`);
                console.log(`   Already Matched: ${potentialMatch.metadata?.matched || false}`);
                console.log(`   Transaction ID: ${potentialMatch.transactionId || 'None'}`);
                
                // FIX: Check if this SMS is already processed
                if (potentialMatch.transactionId || potentialMatch.metadata?.matched) {
                    console.log(`⚠️ Skipping ${potentialMatch._id} - already has transaction ID or marked as matched`);
                    continue;
                }
                
                // Check if transaction numbers are the same (should not match)
                const newRef = newIdentifiers.transactionId || newSMSDeposit.extractedReference;
                const existingRef = potentialMatch.extractedReference || potentialMatch.metadata?.transactionId;
                
                if (newRef && existingRef && newRef === existingRef) {
                    console.log(`⚠️ Skipping match - same transaction number found: ${newRef}`);
                    continue;
                }
                
                // BASIC VALIDATION: Check if types are opposite
                if (newAnalysis.type !== potentialMatch.smsType) {
                    console.log('✅ Opposite types (good for matching)');
                    
                    // Check amount match
                    if (newSMSDeposit.extractedAmount === potentialMatch.extractedAmount) {
                        console.log('✅ Amounts match exactly');
                        
                        // Check reference match
                        const refMatch = this.checkReferenceMatch(newSMSDeposit, potentialMatch, newIdentifiers);
                        if (refMatch) {
                            console.log(`✅ References match! Auto-approving...`);
                            
                            // Determine which is user SMS (SENDER) and which is admin SMS (RECEIVER)
                            let userSMS, adminSMS;
                            if (newAnalysis.type === 'SENDER') {
                                userSMS = newSMSDeposit;
                                adminSMS = potentialMatch;
                            } else {
                                userSMS = potentialMatch;
                                adminSMS = newSMSDeposit;
                            }
                            
                            // Auto-approve immediately
                            try {
                                const result = await this.approveCBE_MatchedSMS(userSMS, adminSMS);
                                console.log('✅ CBE transaction auto-approved and deposited!');
                                return result;
                            } catch (approvalError) {
                                console.error('❌ Error auto-approving CBE match:', approvalError);
                                // Try next match
                                continue;
                            }
                        }
                    }
                }
            }
        }
        
        // If no match found, wait for match
        console.log('❌ No immediate match found. Marking as waiting...');
        newSMSDeposit.status = 'RECEIVED_WAITING_MATCH';
        await newSMSDeposit.save();
        
        // Try batch matching in case other SMS comes later
        setTimeout(async () => {
            try {
                console.log('🔄 Running delayed batch matching...');
                await this.batchMatchCBE_SMS();
            } catch (error) {
                console.error('❌ Error in delayed batch matching:', error);
            }
        }, 5000); // Try again in 5 seconds
        
        return null;
        
    } catch (error) {
        console.error('❌ Error in CBE matching:', error);
        
        // Fallback
        try {
            newSMSDeposit.status = 'RECEIVED';
            newSMSDeposit.metadata.cbeMatchingError = error.message;
            await newSMSDeposit.save();
        } catch (saveError) {
            console.error('❌ Could not save CBE SMS deposit:', saveError);
        }
        
        return null;
    }
}


    // NEW: Simple reference match checker
    static checkReferenceMatch(sms1, sms2, identifiers1) {
        // Get identifiers for second SMS
        const identifiers2 = this.extractTransactionIdentifiers(sms2.originalSMS);
        
        console.log('🔑 Checking reference match:');
        console.log(`   SMS1 Ref: ${sms1.extractedReference}`);
        console.log(`   SMS2 Ref: ${sms2.extractedReference}`);
        console.log(`   Ident1 Clean Ref: ${identifiers1.cleanRefNumber}`);
        console.log(`   Ident2 Clean Ref: ${identifiers2.cleanRefNumber}`);
        
        // Check extracted references
        if (sms1.extractedReference && sms2.extractedReference) {
            if (sms1.extractedReference === sms2.extractedReference) {
                return true;
            }
        }
        
        // Check clean references
        if (identifiers1.cleanRefNumber && identifiers2.cleanRefNumber) {
            if (identifiers1.cleanRefNumber === identifiers2.cleanRefNumber) {
                return true;
            }
        }
        
        // Check if one contains the other
        const ref1 = sms1.extractedReference || identifiers1.cleanRefNumber || identifiers1.refNumber;
        const ref2 = sms2.extractedReference || identifiers2.cleanRefNumber || identifiers2.refNumber;
        
        if (ref1 && ref2) {
            if (ref1.includes(ref2) || ref2.includes(ref1)) {
                return true;
            }
        }
        
        return false;
    }
    // Add this method to your WalletService class

    /**
    * Auto-match all waiting SMS deposits
    */
 static async autoMatchAllSMS() {
    console.log('🔄 Starting enhanced auto-match for all waiting SMS...');
    
    const session = await mongoose.startSession();
    session.startTransaction();
    
    try {
        // Get all unmatched SMS with better filtering
        // FIX: Only get SMS that are not already processed
        const [senderSMSList, receiverSMSList] = await Promise.all([
            SMSDeposit.find({
                status: 'RECEIVED_WAITING_MATCH',
                smsType: 'SENDER',
                extractedAmount: { $gt: 0 },
                // FIX: Exclude already processed
                transactionId: { $exists: false },
                autoApproved: { $ne: true },
                'metadata.matched': { $ne: true }
            })
            .populate('userId', 'firstName username telegramId')
            .sort({ createdAt: -1 })
            .limit(200),
            
            SMSDeposit.find({
                status: 'RECEIVED_WAITING_MATCH',
                smsType: 'RECEIVER',
                extractedAmount: { $gt: 0 },
                // FIX: Exclude already processed
                transactionId: { $exists: false },
                autoApproved: { $ne: true },
                'metadata.matched': { $ne: true }
            })
            .populate('userId', 'firstName username telegramId')
            .sort({ createdAt: -1 })
            .limit(200)
        ]);
        
        console.log(`📊 Found ${senderSMSList.length} sender SMS and ${receiverSMSList.length} receiver SMS`);
        
        // CRITICAL: First try exact CBE reference matches (like your example)
        const matchedPairs = [];
        const matchedSenderIds = new Set();
        const matchedReceiverIds = new Set();
        
        // Enhanced CBE matching with reference
        for (const senderSMS of senderSMSList) {
            if (matchedSenderIds.has(senderSMS._id.toString())) continue;
            
            // Skip if already processed
            if (senderSMS.transactionId || senderSMS.autoApproved || senderSMS.metadata?.matched) {
                console.log(`⚠️ Skipping sender SMS ${senderSMS._id} - already processed`);
                continue;
            }
            
            // Skip if no reference or amount
            if (!senderSMS.extractedAmount || !senderSMS.extractedReference) continue;
            
            for (const receiverSMS of receiverSMSList) {
                if (matchedReceiverIds.has(receiverSMS._id.toString())) continue;
                
                // Skip if already processed
                if (receiverSMS.transactionId || receiverSMS.autoApproved || receiverSMS.metadata?.matched) {
                    console.log(`⚠️ Skipping receiver SMS ${receiverSMS._id} - already processed`);
                    continue;
                }
                
                // Skip if no reference or amount
                if (!receiverSMS.extractedAmount || !receiverSMS.extractedReference) continue;
                
                // FIX: Check if transaction numbers are the same (should not match)
                if (senderSMS.extractedReference === receiverSMS.extractedReference) {
                    console.log(`⚠️ Skipping match - same transaction number: ${senderSMS.extractedReference}`);
                    continue;
                }
                
                console.log(`🔍 Checking match: ${senderSMS._id} (Ref: ${senderSMS.extractedReference}) vs ${receiverSMS._id} (Ref: ${receiverSMS.extractedReference})`);
                
                // CRITICAL: Check for CBE reference match
                const isCBEReferenceMatch = senderSMS.extractedReference === receiverSMS.extractedReference;
                
                // Check amount match (exact for CBE)
                const isAmountMatch = senderSMS.extractedAmount === receiverSMS.extractedAmount;
                
                // Check time proximity (within 30 minutes for CBE)
                const timeDiff = Math.abs(
                    new Date(senderSMS.createdAt).getTime() - 
                    new Date(receiverSMS.createdAt).getTime()
                );
                const isWithinTimeWindow = timeDiff <= 30 * 60 * 1000; // 30 minutes
                
                // Calculate match score for CBE
                if (isCBEReferenceMatch && isAmountMatch && isWithinTimeWindow) {
                    console.log(`✅ CBE EXACT MATCH FOUND: ${senderSMS._id} ↔ ${receiverSMS._id}`);
                    console.log(`   Reference: ${senderSMS.extractedReference}`);
                    console.log(`   Amount: $${senderSMS.extractedAmount}`);
                    console.log(`   Time diff: ${timeDiff/1000}s`);
                    
                    // Calculate confidence score (100% for exact match)
                    const confidenceScore = 1.0; // 100% confidence
                    
                    try {
                        // Use the existing approveMatchedSMS method
                        const result = await this.approveMatchedSMS(senderSMS, receiverSMS);
                        
                        matchedPairs.push({
                            senderSMSId: senderSMS._id,
                            receiverSMSId: receiverSMS._id,
                            amount: senderSMS.extractedAmount,
                            reference: senderSMS.extractedReference,
                            matchType: 'CBE_EXACT_REFERENCE',
                            confidence: confidenceScore,
                            timeDiff: timeDiff / 1000
                        });
                        
                        matchedSenderIds.add(senderSMS._id.toString());
                        matchedReceiverIds.add(receiverSMS._id.toString());
                        
                        console.log(`✅ Auto-approved CBE transaction: $${senderSMS.extractedAmount} (Ref: ${senderSMS.extractedReference})`);
                        
                        break; // Move to next sender SMS
                    } catch (approvalError) {
                        console.error(`❌ Error approving CBE exact match:`, approvalError.message);
                    }
                }
                
                // Also try partial reference match for CBE
                else if (senderSMS.extractedReference && receiverSMS.extractedReference) {
                    const ref1 = senderSMS.extractedReference;
                    const ref2 = receiverSMS.extractedReference;
                    
                    // Check if one contains the other (partial match)
                    const isPartialMatch = (ref1.includes(ref2) || ref2.includes(ref1));
                    
                    if (isPartialMatch && isAmountMatch && isWithinTimeWindow) {
                        console.log(`✅ CBE PARTIAL REFERENCE MATCH: ${senderSMS._id} ↔ ${receiverSMS._id}`);
                        console.log(`   Ref1: ${ref1}, Ref2: ${ref2}`);
                        
                        const confidenceScore = 0.9; // 90% confidence for partial match
                        
                        try {
                            const result = await this.approveMatchedSMS(senderSMS, receiverSMS);
                            
                            matchedPairs.push({
                                senderSMSId: senderSMS._id,
                                receiverSMSId: receiverSMS._id,
                                amount: senderSMS.extractedAmount,
                                reference: `${ref1} / ${ref2}`,
                                matchType: 'CBE_PARTIAL_REFERENCE',
                                confidence: confidenceScore,
                                timeDiff: timeDiff / 1000
                            });
                            
                            matchedSenderIds.add(senderSMS._id.toString());
                            matchedReceiverIds.add(receiverSMS._id.toString());
                            
                            console.log(`✅ Auto-approved CBE partial match transaction`);
                            
                            break;
                        } catch (approvalError) {
                            console.error(`❌ Error approving CBE partial match:`, approvalError.message);
                        }
                    }
                }
            }
        }
        
        // Second pass: Amount-only matches for SMS without references
        const unmatchedSenders = senderSMSList.filter(
            sms => !matchedSenderIds.has(sms._id.toString()) && 
                   !sms.transactionId && 
                   !sms.autoApproved && 
                   !sms.metadata?.matched
        );
        const unmatchedReceivers = receiverSMSList.filter(
            sms => !matchedReceiverIds.has(sms._id.toString()) && 
                   !sms.transactionId && 
                   !sms.autoApproved && 
                   !sms.metadata?.matched
        );
        
        console.log(`🔄 Trying amount-only matches: ${unmatchedSenders.length} senders, ${unmatchedReceivers.length} receivers`);
        
        for (const senderSMS of unmatchedSenders) {
            if (matchedSenderIds.has(senderSMS._id.toString())) continue;
            
            for (const receiverSMS of unmatchedReceivers) {
                if (matchedReceiverIds.has(receiverSMS._id.toString())) continue;
                
                // Amount match (allow small tolerance)
                const amountDiff = Math.abs(senderSMS.extractedAmount - receiverSMS.extractedAmount);
                const isAmountMatch = amountDiff < 0.01;
                
                // Time window (1 hour for amount-only matches)
                const timeDiff = Math.abs(
                    new Date(senderSMS.createdAt).getTime() - 
                    new Date(receiverSMS.createdAt).getTime()
                );
                const isWithinTimeWindow = timeDiff <= 60 * 60 * 1000; // 1 hour
                
                if (isAmountMatch && isWithinTimeWindow) {
                    // Calculate confidence based on time difference
                    let confidenceScore = 0.85; // Base 85% for amount match
                    
                    // Reduce confidence based on time difference
                    if (timeDiff > 15 * 60 * 1000) confidenceScore -= 0.1;
                    if (timeDiff > 30 * 60 * 1000) confidenceScore -= 0.1;
                    
                    if (confidenceScore >= 0.85) {
                        console.log(`✅ AMOUNT-ONLY MATCH: ${senderSMS._id} ↔ ${receiverSMS._id}`);
                        console.log(`   Amount: $${senderSMS.extractedAmount}, Time diff: ${timeDiff/1000}s`);
                        
                        try {
                            const result = await this.approveMatchedSMS(senderSMS, receiverSMS);
                            
                            matchedPairs.push({
                                senderSMSId: senderSMS._id,
                                receiverSMSId: receiverSMS._id,
                                amount: senderSMS.extractedAmount,
                                reference: senderSMS.extractedReference || receiverSMS.extractedReference || 'NO_REF',
                                matchType: 'AMOUNT_ONLY',
                                confidence: confidenceScore,
                                timeDiff: timeDiff / 1000
                            });
                            
                            matchedSenderIds.add(senderSMS._id.toString());
                            matchedReceiverIds.add(receiverSMS._id.toString());
                            
                            console.log(`✅ Auto-approved amount-only transaction`);
                            
                            break;
                        } catch (approvalError) {
                            console.error(`❌ Error approving amount-only match:`, approvalError.message);
                        }
                    }
                }
            }
        }
        
        // Commit all transactions
        await session.commitTransaction();
        
        console.log(`✅ Auto-match completed: ${matchedPairs.length} pairs matched`);
        
        // Generate summary by match type
        const summary = {
            cbeExactMatches: matchedPairs.filter(p => p.matchType === 'CBE_EXACT_REFERENCE').length,
            cbePartialMatches: matchedPairs.filter(p => p.matchType === 'CBE_PARTIAL_REFERENCE').length,
            amountOnlyMatches: matchedPairs.filter(p => p.matchType === 'AMOUNT_ONLY').length,
            totalAmount: matchedPairs.reduce((sum, p) => sum + p.amount, 0)
        };
        
        // Log detailed results
        matchedPairs.forEach(pair => {
            console.log(`📊 Matched: $${pair.amount} (${pair.matchType}, ${Math.round(pair.confidence * 100)}% confidence)`);
        });
        
        return {
            matchedPairs: matchedPairs.length,
            remainingSMS: {
                SENDER: senderSMSList.length - matchedSenderIds.size,
                RECEIVER: receiverSMSList.length - matchedReceiverIds.size
            },
            details: matchedPairs,
            summary: summary
        };
        
    } catch (error) {
        await session.abortTransaction();
        console.error('❌ Error in autoMatchAllSMS:', error);
        throw error;
    } finally {
        session.endSession();
    }
}
    /**
    * Helper: Auto-match based on reference groups (for batch processing)
    */
    static async autoMatchByReferenceGroups() {
      try {
        console.log('🔍 Finding reference groups for auto-matching...');
        
        // Find all SMS deposits grouped by reference
        const referenceGroups = await SMSDeposit.aggregate([
          {
            $match: {
              status: 'RECEIVED_WAITING_MATCH',
              extractedReference: { $exists: true, $ne: null, $ne: '' },
              extractedAmount: { $gt: 0 }
            }
          },
          {
            $group: {
              _id: '$extractedReference',
              count: { $sum: 1 },
              senders: {
                $push: {
                  $cond: [{ $eq: ['$smsType', 'SENDER'] }, '$$ROOT', null]
                }
              },
              receivers: {
                $push: {
                  $cond: [{ $eq: ['$smsType', 'RECEIVER'] }, '$$ROOT', null]
                }
              },
              totalAmount: { $sum: '$extractedAmount' },
              uniqueAmounts: { $addToSet: '$extractedAmount' }
            }
          },
          {
            $project: {
              _id: 1,
              count: 1,
              senders: { $filter: { input: '$senders', as: 'sender', cond: { $ne: ['$$sender', null] } } },
              receivers: { $filter: { input: '$receivers', as: 'receiver', cond: { $ne: ['$$receiver', null] } } },
              totalAmount: 1,
              uniqueAmounts: 1,
              hasBothTypes: {
                $and: [
                  { $gt: [{ $size: { $filter: { input: '$senders', as: 'sender', cond: { $ne: ['$$sender', null] } } } }, 0] },
                  { $gt: [{ $size: { $filter: { input: '$receivers', as: 'receiver', cond: { $ne: ['$$receiver', null] } } } }, 0] }
                ]
              }
            }
          },
          {
            $match: {
              hasBothTypes: true,
              count: { $gte: 2 } // At least one sender and one receiver
            }
          },
          { $sort: { count: -1 } }
        ]);
        
        console.log(`📊 Found ${referenceGroups.length} reference groups with both sender and receiver SMS`);
        
        const matchedPairs = [];
        
        // Process each reference group
        for (const group of referenceGroups) {
          const senders = group.senders;
          const receivers = group.receivers;
          
          // Try to match each sender with each receiver
          for (const senderSMS of senders) {
            for (const receiverSMS of receivers) {
              // Check if they have the same amount (or very close)
              const amountDiff = Math.abs(senderSMS.extractedAmount - receiverSMS.extractedAmount);
              const isAmountMatch = amountDiff < 0.01;
              
              // Check time proximity (within 15 minutes)
              const timeDiff = Math.abs(
                new Date(senderSMS.createdAt).getTime() - 
                new Date(receiverSMS.createdAt).getTime()
              );
              const isWithinTimeWindow = timeDiff <= 15 * 60 * 1000; // 15 minutes
              
              if (isAmountMatch && isWithinTimeWindow) {
                try {
                  console.log(`✅ Found match in reference group ${group._id}: ${senderSMS._id} ↔ ${receiverSMS._id}`);
                  
                  // Populate user data
                  const populatedSender = await SMSDeposit.findById(senderSMS._id)
                    .populate('userId', 'firstName username telegramId');
                  const populatedReceiver = await SMSDeposit.findById(receiverSMS._id)
                    .populate('userId', 'firstName username telegramId');
                  
                  if (!populatedSender || !populatedReceiver) continue;
                  
                  // Approve the match
                  const result = await this.approveMatchedSMS(populatedSender, populatedReceiver);
                  
                  matchedPairs.push({
                    reference: group._id,
                    senderSMSId: senderSMS._id,
                    receiverSMSId: receiverSMS._id,
                    amount: senderSMS.extractedAmount,
                    timeDiff: timeDiff / 1000,
                    matchType: 'REFERENCE_GROUP'
                  });
                  
                  // Remove matched SMS from arrays
                  senders.splice(senders.indexOf(senderSMS), 1);
                  receivers.splice(receivers.indexOf(receiverSMS), 1);
                  
                  break; // Move to next sender
                } catch (error) {
                  console.error(`❌ Error matching in reference group ${group._id}:`, error.message);
                }
              }
            }
          }
        }
        
        console.log(`✅ Reference group matching completed: ${matchedPairs.length} pairs matched`);
        
        return {
          referenceGroups: referenceGroups.length,
          matchedPairs: matchedPairs.length,
          details: matchedPairs
        };
        
      } catch (error) {
        console.error('❌ Error in autoMatchByReferenceGroups:', error);
        throw error;
      }
    }

    /**
    * Smart batch matching with multiple strategies
    */
    static async smartBatchMatchSMS() {
      console.log('🤖 Starting smart batch matching...');
      
      const results = {
        totalMatched: 0,
        strategyResults: [],
        errors: []
      };
      
      try {
        // Strategy 1: Reference-based matching
        console.log('🔍 Strategy 1: Reference-based matching');
        try {
          const refResult = await this.autoMatchByReferenceGroups();
          results.strategyResults.push({
            strategy: 'REFERENCE_BASED',
            matched: refResult.matchedPairs,
            details: refResult
          });
          results.totalMatched += refResult.matchedPairs;
        } catch (error) {
          results.errors.push(`Reference-based matching failed: ${error.message}`);
        }
        
        // Strategy 2: Amount + time window matching
        console.log('🔍 Strategy 2: Amount + time window matching');
        try {
          const amountResult = await this.matchByAmountAndTime();
          results.strategyResults.push({
            strategy: 'AMOUNT_TIME',
            matched: amountResult.matchedPairs,
            details: amountResult
          });
          results.totalMatched += amountResult.matchedPairs;
        } catch (error) {
          results.errors.push(`Amount+time matching failed: ${error.message}`);
        }
        
        // Strategy 3: CBE-specific matching
        console.log('🔍 Strategy 3: CBE-specific matching');
        try {
          const cbeResult = await this.matchCBE_Batch();
          results.strategyResults.push({
            strategy: 'CBE_SPECIFIC',
            matched: cbeResult.matchedPairs,
            details: cbeResult
          });
          results.totalMatched += cbeResult.matchedPairs;
        } catch (error) {
          results.errors.push(`CBE matching failed: ${error.message}`);
        }
        
        // Strategy 4: Telebirr matching
        console.log('🔍 Strategy 4: Telebirr matching');
        try {
          const telebirrResult = await this.matchTelebirrBatch();
          results.strategyResults.push({
            strategy: 'TELEBIRR',
            matched: telebirrResult.matchedPairs,
            details: telebirrResult
          });
          results.totalMatched += telebirrResult.matchedPairs;
        } catch (error) {
          results.errors.push(`Telebirr matching failed: ${error.message}`);
        }
        
        console.log(`✅ Smart batch matching completed: ${results.totalMatched} total pairs matched`);
        
        return results;
        
      } catch (error) {
        console.error('❌ Error in smart batch matching:', error);
        throw error;
      }
    }

    /**
    * Helper: Match by amount and time window
    */
    static async matchByAmountAndTime() {
      try {
        console.log('🔍 Matching by amount and time window...');
        
        // Get sender and receiver SMS
        const [senders, receivers] = await Promise.all([
          SMSDeposit.find({
            status: 'RECEIVED_WAITING_MATCH',
            smsType: 'SENDER',
            extractedAmount: { $gt: 0 }
          })
          .populate('userId', 'firstName username telegramId')
          .sort({ createdAt: -1 })
          .limit(50),
          
          SMSDeposit.find({
            status: 'RECEIVED_WAITING_MATCH',
            smsType: 'RECEIVER',
            extractedAmount: { $gt: 0 }
          })
          .populate('userId', 'firstName username telegramId')
          .sort({ createdAt: -1 })
          .limit(50)
        ]);
        
        const matchedPairs = [];
        const matchedSenderIds = new Set();
        const matchedReceiverIds = new Set();
        
        // Group senders by amount
        const sendersByAmount = {};
        senders.forEach(sender => {
          const amountKey = sender.extractedAmount.toFixed(2);
          if (!sendersByAmount[amountKey]) {
            sendersByAmount[amountKey] = [];
          }
          sendersByAmount[amountKey].push(sender);
        });
        
        // Group receivers by amount
        const receiversByAmount = {};
        receivers.forEach(receiver => {
          const amountKey = receiver.extractedAmount.toFixed(2);
          if (!receiversByAmount[amountKey]) {
            receiversByAmount[amountKey] = [];
          }
          receiversByAmount[amountKey].push(receiver);
        });
        
        // Match by same amount
        for (const [amountKey, senderList] of Object.entries(sendersByAmount)) {
          const receiverList = receiversByAmount[amountKey];
          if (!receiverList || receiverList.length === 0) continue;
          
          // Try to match each sender with each receiver
          for (const senderSMS of senderList) {
            if (matchedSenderIds.has(senderSMS._id.toString())) continue;
            
            for (const receiverSMS of receiverList) {
              if (matchedReceiverIds.has(receiverSMS._id.toString())) continue;
              
              // Check time window (within 30 minutes)
              const timeDiff = Math.abs(
                new Date(senderSMS.createdAt).getTime() - 
                new Date(receiverSMS.createdAt).getTime()
              );
              
              if (timeDiff <= 30 * 60 * 1000) { // 30 minutes
                try {
                  console.log(`✅ Amount+time match found: $${amountKey}, time diff: ${Math.round(timeDiff/1000)}s`);
                  
                  const result = await this.approveMatchedSMS(senderSMS, receiverSMS);
                  
                  matchedPairs.push({
                    senderSMSId: senderSMS._id,
                    receiverSMSId: receiverSMS._id,
                    amount: senderSMS.extractedAmount,
                    timeDiff: timeDiff / 1000
                  });
                  
                  matchedSenderIds.add(senderSMS._id.toString());
                  matchedReceiverIds.add(receiverSMS._id.toString());
                  
                  break; // Move to next sender
                } catch (error) {
                  console.error(`❌ Error in amount+time match:`, error.message);
                }
              }
            }
          }
        }
        
        console.log(`✅ Amount+time matching: ${matchedPairs.length} pairs matched`);
        
        return {
          matchedPairs: matchedPairs.length,
          details: matchedPairs,
          remainingSMS: {
            SENDER: senders.length - matchedSenderIds.size,
            RECEIVER: receivers.length - matchedReceiverIds.size
          }
        };
        
      } catch (error) {
        console.error('❌ Error in matchByAmountAndTime:', error);
        throw error;
      }
    }

    /**
    * Helper: Batch match CBE SMS
    */
    static async matchCBE_Batch() {
      try {
        console.log('🏦 Batch matching CBE SMS...');
        
        const cbeSMS = await SMSDeposit.find({
          status: 'RECEIVED_WAITING_MATCH',
          paymentMethod: { $regex: /CBE/i }
        })
        .populate('userId', 'firstName username telegramId')
        .sort({ createdAt: -1 })
        .limit(100);
        
        if (cbeSMS.length < 2) {
          return { matchedPairs: 0, details: [] };
        }
        
        // Group by reference
        const byReference = {};
        cbeSMS.forEach(sms => {
          const ref = sms.extractedReference || 'NO_REF';
          if (!byReference[ref]) {
            byReference[ref] = { senders: [], receivers: [] };
          }
          if (sms.smsType === 'SENDER') {
            byReference[ref].senders.push(sms);
          } else {
            byReference[ref].receivers.push(sms);
          }
        });
        
        const matchedPairs = [];
        
        // Try to match within each reference group
        for (const [ref, group] of Object.entries(byReference)) {
          if (group.senders.length === 0 || group.receivers.length === 0) continue;
          
          // Sort by amount for better matching
          group.senders.sort((a, b) => a.extractedAmount - b.extractedAmount);
          group.receivers.sort((a, b) => a.extractedAmount - b.extractedAmount);
          
          // Try to match sender with receiver of same amount
          for (const sender of group.senders) {
            const matchingReceiver = group.receivers.find(
              receiver => Math.abs(receiver.extractedAmount - sender.extractedAmount) < 0.01
            );
            
            if (matchingReceiver) {
              try {
                console.log(`✅ CBE batch match found: ${sender._id} ↔ ${matchingReceiver._id} (Ref: ${ref})`);
                
                const result = await this.approveMatchedSMS(sender, matchingReceiver);
                
                matchedPairs.push({
                  senderSMSId: sender._id,
                  receiverSMSId: matchingReceiver._id,
                  amount: sender.extractedAmount,
                  reference: ref
                });
                
                // Remove matched receiver
                group.receivers.splice(group.receivers.indexOf(matchingReceiver), 1);
                
              } catch (error) {
                console.error(`❌ Error in CBE batch match:`, error.message);
              }
            }
          }
        }
        
        console.log(`✅ CBE batch matching: ${matchedPairs.length} pairs matched`);
        
        return {
          matchedPairs: matchedPairs.length,
          details: matchedPairs
        };
        
      } catch (error) {
        console.error('❌ Error in matchCBE_Batch:', error);
        throw error;
      }
    }

    /**
    * Helper: Batch match Telebirr SMS
    */
    static async matchTelebirrBatch() {
      try {
        console.log('📱 Batch matching Telebirr SMS...');
        
        const telebirrSMS = await SMSDeposit.find({
          status: 'RECEIVED_WAITING_MATCH',
          paymentMethod: { $regex: /Telebirr/i }
        })
        .populate('userId', 'firstName username telegramId')
        .sort({ createdAt: -1 })
        .limit(50);
        
        const matchedPairs = [];
        
        // Telebirr usually has transaction numbers, match by reference
        for (let i = 0; i < telebirrSMS.length; i++) {
          const sms1 = telebirrSMS[i];
          if (sms1.status !== 'RECEIVED_WAITING_MATCH') continue;
          
          for (let j = i + 1; j < telebirrSMS.length; j++) {
            const sms2 = telebirrSMS[j];
            if (sms2.status !== 'RECEIVED_WAITING_MATCH') continue;
            
            // Check if they are opposite types
            if (sms1.smsType === sms2.smsType) continue;
            
            // Check amount match
            const amountDiff = Math.abs(sms1.extractedAmount - sms2.extractedAmount);
            if (amountDiff > 0.01) continue;
            
            // Check if one is sender and one is receiver
            let senderSMS, receiverSMS;
            if (sms1.smsType === 'SENDER') {
              senderSMS = sms1;
              receiverSMS = sms2;
            } else {
              senderSMS = sms2;
              receiverSMS = sms1;
            }
            
            // Check reference match (for Telebirr)
            const ref1 = senderSMS.extractedReference || '';
            const ref2 = receiverSMS.extractedReference || '';
            const hasReferenceMatch = ref1 && ref2 && ref1 === ref2;
            
            // Telebirr transactions often have same time
            const timeDiff = Math.abs(
              new Date(senderSMS.createdAt).getTime() - 
              new Date(receiverSMS.createdAt).getTime()
            );
            
            if (hasReferenceMatch || timeDiff <= 2 * 60 * 1000) { // 2 minutes for Telebirr
              try {
                console.log(`✅ Telebirr match found: ${senderSMS._id} ↔ ${receiverSMS._id}`);
                
                const result = await this.approveMatchedSMS(senderSMS, receiverSMS);
                
                matchedPairs.push({
                  senderSMSId: senderSMS._id,
                  receiverSMSId: receiverSMS._id,
                  amount: senderSMS.extractedAmount,
                  reference: hasReferenceMatch ? ref1 : 'TIME_BASED',
                  timeDiff: timeDiff / 1000
                });
                
                break; // Move to next SMS
              } catch (error) {
                console.error(`❌ Error in Telebirr match:`, error.message);
              }
            }
          }
        }
        
        console.log(`✅ Telebirr batch matching: ${matchedPairs.length} pairs matched`);
        
        return {
          matchedPairs: matchedPairs.length,
          details: matchedPairs
        };
        
      } catch (error) {
        console.error('❌ Error in matchTelebirrBatch:', error);
        throw error;
      }
    }
    // NEW: Analyze SMS type (sender vs receiver)
static analyzeSMSType(smsText) {
    const sms = smsText.toLowerCase();
    
    console.log('🔍 Analyzing SMS type (Amharic/English)...');
    
    // TELEBIRR SPECIFIC PATTERNS - AMHARIC FIRST
    // Amharic Telebirr receiver pattern: "ተቀብለዋል" means "received"
    if (sms.includes('ተቀብለዋል') || sms.includes('ተቀብሏል')) {
        console.log('✅ Detected as Telebirr RECEIVER SMS (Amharic)');
        return { type: 'RECEIVER', confidence: 0.95, bank: 'Telebirr' };
    }
    
    // Amharic Telebirr sender pattern: "የላኩ" means "sent"
    if (sms.includes('የላኩ') && (sms.includes('በቴሌብር') || sms.includes('telebirr'))) {
        console.log('✅ Detected as Telebirr SENDER SMS (Amharic)');
        return { type: 'SENDER', confidence: 0.95, bank: 'Telebirr' };
    }
    
    // English Telebirr receiver pattern
    if (sms.includes('you have received') && sms.includes('telebirr')) {
        console.log('✅ Detected as Telebirr RECEIVER SMS (English)');
        return { type: 'RECEIVER', confidence: 0.95, bank: 'Telebirr' };
    }
    
    // English Telebirr sender pattern
    if (sms.includes('you have sent') && sms.includes('telebirr')) {
        console.log('✅ Detected as Telebirr SENDER SMS (English)');
        return { type: 'SENDER', confidence: 0.95, bank: 'Telebirr' };
    }
    
    // CBE SENDER patterns (user sent money)
    const cbeSenderPatterns = [
        /you have transfered.*etb.*to.*on.*from your account/i,
        /your account has been debited with a s.charge/i,
        /you have transferred etb.*to/i,
        /transfer.*etb.*to.*account/i,
        /debited.*account.*s.charge/i
    ];
    
    // CBE RECEIVER patterns (admin received money)
    const cbeReceiverPatterns = [
        /your account.*has been credited with etb.*from/i,
        /account.*credited.*etb.*from/i,
        /credited with.*etb.*from/i,
        /account.*has been credited.*ref no/i
    ];
    
    // Check for CBE sender patterns
    for (const pattern of cbeSenderPatterns) {
        if (pattern.test(sms)) {
            console.log('✅ Detected as CBE SENDER SMS');
            return { type: 'SENDER', confidence: 0.95, bank: 'CBE' };
        }
    }
    
    // Check for CBE receiver patterns
    for (const pattern of cbeReceiverPatterns) {
        if (pattern.test(sms)) {
            console.log('✅ Detected as CBE RECEIVER SMS');
            return { type: 'RECEIVER', confidence: 0.95, bank: 'CBE' };
        }
    }
    
    // Generic patterns (fallback)
    const genericSenderPatterns = [
        /sent.*etb|birr|br|ብር/i,
        /transfer.*etb|birr|br|ብር/i,
        /debited/i,
        /የላኩ/i  // Amharic for "sent"
    ];
    
    const genericReceiverPatterns = [
        /received.*etb|birr|br|ብር/i,
        /credited/i,
        /ተቀብለዋል|ተቀብሏል/i  // Amharic for "received"
    ];
    
    for (const pattern of genericSenderPatterns) {
        if (pattern.test(sms)) {
            console.log('✅ Detected as generic SENDER SMS');
            return { type: 'SENDER', confidence: 0.8 };
        }
    }
    
    for (const pattern of genericReceiverPatterns) {
        if (pattern.test(sms)) {
            console.log('✅ Detected as generic RECEIVER SMS');
            return { type: 'RECEIVER', confidence: 0.8 };
        }
    }
    
    console.log('❓ Unknown SMS type');
    return { type: 'UNKNOWN', confidence: 0.5 };
}

      static detectPaymentMethodFromSMS(smsText) {
        const sms = smsText.toLowerCase();
        
        if (sms.includes('cbe') && sms.includes('birr')) return 'CBE Birr';
        if (sms.includes('cbe') && !sms.includes('birr')) return 'CBE Bank';
        if (sms.includes('awash')) return 'Bank of Abysinia';
        if (sms.includes('dashen')) return 'Dashen Bank';
        if (sms.includes('telebirr')) return 'Telebirr';
        
        return 'UNKNOWN';
      }

      static parseSMSTime(timeString) {
        try {
          const cleaned = timeString.replace(' at ', ' ');
          return new Date(cleaned);
        } catch (error) {
          console.error('Error parsing time:', timeString, error);
          return null;
        }
      }

      static namesAreSimilar(name1, name2) {
        if (!name1 || !name2) return false;
        
        const clean1 = name1.toLowerCase().replace(/\s+/g, ' ').trim();
        const clean2 = name2.toLowerCase().replace(/\s+/g, ' ').trim();
        
        if (clean1 === clean2) return true;
        
        if (clean1.includes(clean2) || clean2.includes(clean1)) {
          return true;
        }
        
        const name1Parts = clean1.split(' ');
        const name2Parts = clean2.split(' ');
        
        if (name1Parts[0] === name2Parts[0]) {
          return true;
        }
        
        let matches = 0;
        for (const word1 of name1Parts) {
          for (const word2 of name2Parts) {
            if (word1 === word2 || word1.includes(word2) || word2.includes(word1)) {
              matches++;
              break;
            }
          }
        }
        
        const similarity = matches / Math.max(name1Parts.length, name2Parts.length);
        return similarity >= 0.5;
      }

      static extractAmountFromSMS(smsText) {
        try {
          console.log('🔍 Extracting amount from SMS:', smsText.substring(0, 100));
          
          const patterns = [
            /(\d+\.?\d*)\s*ETB/i,
            /(\d+\.?\d*)\s*Br/i,
            /(\d+\.?\d*)\s*birr/i,
            /amount[:\s]*(\d+\.?\d*)/i,
            /sent\s*(\d+\.?\d*)/i,
            /received\s*(\d+\.?\d*)/i,
            /transfer\s*(\d+\.?\d*)/i,
            /you have sent\s*(\d+\.?\d*)/i,
            /deposit\s*(\d+\.?\d*)/i,
            /(\d+\.?\d*)\s*(?:ETB|Birr|Br)/i,
            /(?:ETB|Birr|Br)\s*(\d+\.?\d*)/i
          ];

          let amount = null;
          
          for (const pattern of patterns) {
            const match = smsText.match(pattern);
            if (match && match[1]) {
              amount = parseFloat(match[1]);
              console.log('✅ Amount extracted with pattern:', pattern, amount);
              if (amount > 0) break;
            }
          }

          if (!amount || amount <= 0) {
            const numbers = smsText.match(/\d+\.?\d*/g);
            if (numbers) {
              const possibleAmounts = numbers.map(n => parseFloat(n)).filter(n => n >= 1 && n <= 10000);
              if (possibleAmounts.length > 0) {
                amount = possibleAmounts[0];
                console.log('✅ Amount extracted as first reasonable number:', amount);
              }
            }
          }

          return amount;
        } catch (error) {
          console.error('❌ Error extracting amount from SMS:', error);
          return null;
        }
      }
    static calculateSMSMatchScore(sms1Identifiers, sms2Deposit) {
      let score = 0;
      const maxScore = 100;
      
      // Get second SMS identifiers
      const sms2Text = sms2Deposit.originalSMS;
      const sms2Identifiers = this.extractTransactionIdentifiers(sms2Text);
      
      console.log('📊 Comparing SMS identifiers:');
      console.log('SMS1 Type:', sms1Identifiers.isCredit ? 'CREDIT' : sms1Identifiers.isDebit ? 'DEBIT' : 'UNKNOWN');
      console.log('SMS2 Type:', sms2Identifiers.isCredit ? 'CREDIT' : sms2Identifiers.isDebit ? 'DEBIT' : 'UNKNOWN');
      console.log('SMS1 Amount:', sms1Identifiers.amount, 'Exact:', sms1Identifiers.exactAmount);
      console.log('SMS2 Amount:', sms2Identifiers.amount, 'Exact:', sms2Identifiers.exactAmount);
      console.log('SMS1 Ref:', sms1Identifiers.refNumber);
      console.log('SMS2 Ref:', sms2Identifiers.refNumber);
      
      // 1. Check if they're opposite types (one debit, one credit) - 20 points
      if ((sms1Identifiers.isDebit && sms2Identifiers.isCredit) || 
          (sms1Identifiers.isCredit && sms2Identifiers.isDebit)) {
        score += 20;
        console.log('✅ Opposite transaction types');
      } else {
        console.log('❌ Same transaction type - not a match');
        return 0; // Early exit if both are same type
      }
      
      // 2. Amount match (30 points) - Must be exact for CBE
      if (sms1Identifiers.exactAmount && sms2Identifiers.exactAmount) {
        if (sms1Identifiers.exactAmount === sms2Identifiers.exactAmount) {
          score += 30;
          console.log('✅ Exact amount match');
        } else {
          console.log('⚠️ Amount mismatch');
          return 0; // Early exit for amount mismatch
        }
      } else if (sms1Identifiers.amount && sms2Identifiers.amount) {
        // Fallback to regular amount extraction
        if (sms1Identifiers.amount === sms2Identifiers.amount) {
          score += 30;
          console.log('✅ Amount match');
        } else {
          console.log('⚠️ Amount mismatch');
          return 0;
        }
      }
      
      // 3. Transaction/Ref number match (30 points) - Most important
      if (sms1Identifiers.refNumber && sms2Identifiers.refNumber) {
        if (sms1Identifiers.refNumber === sms2Identifiers.refNumber) {
          score += 30;
          console.log('✅ Exact reference number match');
        } else {
          // Try partial match
          const ref1 = sms1Identifiers.refNumber.toLowerCase();
          const ref2 = sms2Identifiers.refNumber.toLowerCase();
          if (ref1.includes(ref2) || ref2.includes(ref1)) {
            score += 25;
            console.log('✅ Partial reference number match');
          } else {
            console.log('⚠️ Reference number mismatch');
            return 0;
          }
        }
      }
      
      // 4. Time match (10 points) - within 5 minutes
      if (sms1Identifiers.time && sms2Identifiers.time) {
        const time1 = this.parseSMSTime(sms1Identifiers.time);
        const time2 = this.parseSMSTime(sms2Identifiers.time);
        
        if (time1 && time2) {
          const timeDiff = Math.abs(time1.getTime() - time2.getTime());
          if (timeDiff <= 5 * 60 * 1000) { // 5 minutes
            score += 10;
            console.log('✅ Time match within 5 minutes');
          } else if (timeDiff <= 10 * 60 * 1000) { // 10 minutes
            score += 5;
            console.log('⏰ Time within 10 minutes');
          }
        }
      }
      
      // 5. Bank match (5 points)
      if (sms1Identifiers.smsBank && sms2Identifiers.smsBank) {
        if (sms1Identifiers.smsBank === sms2Identifiers.smsBank) {
          score += 5;
          console.log('✅ Bank match');
        }
      }
      
      // 6. Name correlation (5 points)
      if (sms1Identifiers.senderName && sms2Identifiers.recipientName) {
        if (this.namesAreSimilar(sms1Identifiers.senderName, sms2Identifiers.recipientName)) {
          score += 5;
          console.log('✅ Names correlate');
        }
      }
      
      const percentage = (score / maxScore) * 100;
      console.log(`📈 Match percentage: ${percentage}% (${score}/${maxScore})`);
      
      return percentage / 100;
    }
    // NEW: Enhanced auto-match logic
    // static async tryAutoMatchSMS(newSMSDeposit, smsText, session = null) {
    //   try {
    //     const newAnalysis = this.analyzeSMSType(smsText);
    //     const newIdentifiers = this.extractTransactionIdentifiers(smsText);
        
    //     console.log('🔍 Attempting to match SMS:', newSMSDeposit._id);
    //     console.log('📊 New SMS type:', newAnalysis.type);
    //     console.log('📊 New SMS amount:', newSMSDeposit.extractedAmount);
    //     console.log('📊 New SMS reference:', newSMSDeposit.extractedReference);
        
    //     if (!newSMSDeposit.extractedAmount || newSMSDeposit.extractedAmount <= 0) {
    //       console.log('⚠️ No valid amount, cannot match');
    //       return null;
    //     }
        
    //     // Find potential matches based on opposite type
    //     const oppositeType = newAnalysis.type === 'SENDER' ? 'RECEIVER' : 'SENDER';
        
    //     // Build query using stored fields
    //     const query = {
    //       _id: { $ne: newSMSDeposit._id },
    //       status: { 
    //         $in: ['RECEIVED', 'RECEIVED_WAITING_MATCH', 'PENDING'] 
    //       },
    //       smsType: oppositeType,
    //       extractedAmount: newSMSDeposit.extractedAmount,
    //       createdAt: { 
    //         $gte: new Date(Date.now() - 60 * 60 * 1000) // Last 1 hour
    //       }
    //     };
        
    //     // If we have a reference, use it for more precise matching
    //     if (newSMSDeposit.extractedReference) {
    //       query.$or = [
    //         { extractedReference: newSMSDeposit.extractedReference },
    //         { 'metadata.refNumber': newSMSDeposit.extractedReference },
    //         { 'metadata.rawRefNumber': newSMSDeposit.extractedReference }
    //       ];
    //       console.log('🔑 Using reference for matching:', newSMSDeposit.extractedReference);
    //     }
        
    //     console.log('🔍 Query for matches:', JSON.stringify(query, null, 2));
        
    //     const potentialMatches = await SMSDeposit.find(query)
    //       .populate('userId', 'firstName username telegramId')
    //       .sort({ createdAt: -1 })
    //       .limit(10);
        
    //     console.log(`🔍 Found ${potentialMatches.length} potential matches`);
        
    //     for (const potentialMatch of potentialMatches) {
    //       const matchScore = this.calculateSMSMatchScore(newIdentifiers, potentialMatch);
    //       console.log(`📊 Match score with ${potentialMatch._id}: ${matchScore}`);
          
    //       if (matchScore >= 0.85) { // 85% match confidence
    //         console.log(`✅ High confidence match found! (${matchScore})`);
            
    //         // APPROVE THE MATCHED TRANSACTION with session
    //         const result = await this.approveMatchedSMS(newSMSDeposit, potentialMatch, session);
    //         return result;
    //       }
    //     }
        
    //     console.log('❌ No strong matches found');
        
    //     // If no match found, update status to waiting for match
    //     newSMSDeposit.status = 'RECEIVED_WAITING_MATCH';
    //     newSMSDeposit.smsType = newAnalysis.type;
        
    //     // Ensure reference is stored
    //     if (newIdentifiers.refNumber && !newSMSDeposit.extractedReference) {
    //       newSMSDeposit.extractedReference = newIdentifiers.refNumber;
    //     }
        
    //     newSMSDeposit.metadata.transactionIdentifiers = newIdentifiers;
        
    //     if (newAnalysis.type === 'SENDER') {
    //       newSMSDeposit.metadata.recipientName = newIdentifiers.recipientName;
    //     } else if (newAnalysis.type === 'RECEIVER') {
    //       newSMSDeposit.metadata.senderName = newIdentifiers.senderName;
    //     }
        
    //     // Use session if provided, otherwise regular save
    //     if (session) {
    //       await newSMSDeposit.save({ session });
    //     } else {
    //       await newSMSDeposit.save();
    //     }
        
    //     return null;
        
    //   } catch (error) {
    //     console.error('❌ Error in auto-matching:', error);
        
    //     // Fallback: Save with basic status
    //     try {
    //       newSMSDeposit.status = 'RECEIVED';
    //       newSMSDeposit.metadata.matchingError = error.message;
    //       await newSMSDeposit.save();
    //     } catch (saveError) {
    //       console.error('❌ Could not save SMS deposit:', saveError);
    //     }
        
    //     return null;
    //   }
    // }
    // NEW: Extract transaction identifiers from SMS
//  static extractTransactionIdentifiers(smsText) {
//         smsText = smsText.trim();
        
//         console.log('🔍 EXTRACTING IDENTIFIERS FOR TELEBIRR/CBE');
        
//         const identifiers = {
//             amount: this.extractAmountFromSMS(smsText),
//             transactionId: null,
//             refNumber: null,
//             time: null,
//             senderName: null,
//             recipientName: null,
//             accountNumbers: [],
//             smsBank: this.detectBankFromSMS(smsText),
//             rawRefNumber: null,
//             isCredit: false,
//             isDebit: false,
//             exactAmount: null,
//             cleanRefNumber: null
//         };

//         const sms = smsText.toLowerCase();
        
//         // Detect transaction type
//         identifiers.isCredit = /credited|received|you have received/i.test(smsText);
//         identifiers.isDebit = /debited|transfered|transferred|sent|you have sent/i.test(smsText);
        
//         console.log('💳 Transaction type:', {
//             isCredit: identifiers.isCredit,
//             isDebit: identifiers.isDebit,
//             bank: identifiers.smsBank
//         });

//         // Extract exact amount
//         const amountMatch = smsText.match(/ETB\s*([\d,]+\.?\d*)/i);
//         if (amountMatch) {
//             const cleanAmount = amountMatch[1].replace(/,/g, '');
//             identifiers.exactAmount = parseFloat(cleanAmount);
//             console.log('💰 Exact amount:', identifiers.exactAmount);
//         }

//         // ========== TELEBIRR SPECIFIC EXTRACTION ==========
//         if (identifiers.smsBank === 'Telebirr') {
//             console.log('📱 Processing Telebirr SMS...');
            
//             // Telebirr transaction number pattern
//             const telebirrPatterns = [
//                 /transaction number is\s*([A-Z0-9]{8,12})/i,
//                 /Your transaction number is\s*([A-Z0-9]{8,12})\./i,
//                 /receipt\/([A-Z0-9]{8,12})/i
//             ];
            
//             for (const pattern of telebirrPatterns) {
//                 const match = smsText.match(pattern);
//                 if (match && match[1]) {
//                     identifiers.refNumber = match[1].toUpperCase();
//                     identifiers.transactionId = identifiers.refNumber;
//                     console.log('✅ Telebirr transaction number found:', identifiers.refNumber);
//                     break;
//                 }
//             }
            
//             // Extract time for Telebirr
//             const timeMatch = smsText.match(/on\s*(\d{2}\/\d{2}\/\d{4})\s*(\d{2}:\d{2}:\d{2})/i);
//             if (timeMatch) {
//                 identifiers.time = `${timeMatch[1]} ${timeMatch[2]}`;
//                 console.log('⏰ Telebirr time:', identifiers.time);
//             }
            
//             // Extract names
//             if (identifiers.isDebit) {
//                 const toMatch = smsText.match(/to\s+([A-Za-z\s]+?)\s*(?:\(|,|\.|$)/i);
//                 if (toMatch) {
//                     identifiers.recipientName = toMatch[1].trim();
//                     console.log('👤 Recipient name (Telebirr):', identifiers.recipientName);
//                 }
//             }
            
//             if (identifiers.isCredit) {
//                 const fromMatch = smsText.match(/from\s+([A-Za-z\s]+?)\s*(?:\(|,|\.|$)/i);
//                 if (fromMatch) {
//                     identifiers.senderName = fromMatch[1].trim();
//                     console.log('👤 Sender name (Telebirr):', identifiers.senderName);
//                 }
//             }
//         }
        
//         // ========== CBE SPECIFIC EXTRACTION ==========
//         else if (identifiers.smsBank === 'CBE') {
//             console.log('🏦 Processing CBE SMS...');
            
//             // CBE URL pattern
//             const urlPattern = /(?:https?:\/\/apps\.cbe\.com\.et(?::\d+)?\/\?id=|id=)([A-Z0-9]+)/i;
//             const urlMatch = smsText.match(urlPattern);
            
//             if (urlMatch && urlMatch[1]) {
//                 const fullId = urlMatch[1].toUpperCase();
//                 identifiers.rawRefNumber = fullId;
                
//                 // CBE pattern: FT + digits + letters + 8 digit account suffix
//                 if (fullId.length >= 20) {
//                     identifiers.refNumber = fullId.substring(0, 12); // FT26026HKU64
//                     identifiers.cleanRefNumber = identifiers.refNumber;
//                     console.log('✅ CBE base reference:', identifiers.refNumber);
//                     console.log('📝 Full reference with suffix:', fullId);
//                 } else {
//                     identifiers.refNumber = fullId;
//                     console.log('✅ CBE reference:', identifiers.refNumber);
//                 }
//             }
            
//             // CBE Ref No pattern
//             if (!identifiers.refNumber) {
//                 const refPattern = /Ref\s*No\s*([A-Z0-9]+)/i;
//                 const refMatch = smsText.match(refPattern);
//                 if (refMatch && refMatch[1]) {
//                     identifiers.refNumber = refMatch[1].toUpperCase();
//                     console.log('✅ CBE Ref No:', identifiers.refNumber);
//                 }
//             }
            
//             // Extract CBE time
//             const timeMatch = smsText.match(/on\s*(\d{2}\/\d{2}\/\d{4})\s*at\s*(\d{2}:\d{2}:\d{2})/i);
//             if (timeMatch) {
//                 identifiers.time = `${timeMatch[1]} ${timeMatch[2]}`;
//                 console.log('⏰ CBE time:', identifiers.time);
//             }
//         }

//         console.log('✅ FINAL IDENTIFIERS:', {
//             refNumber: identifiers.refNumber,
//             cleanRefNumber: identifiers.cleanRefNumber,
//             isCredit: identifiers.isCredit,
//             isDebit: identifiers.isDebit,
//             amount: identifiers.amount,
//             exactAmount: identifiers.exactAmount,
//             senderName: identifiers.senderName,
//             recipientName: identifiers.recipientName,
//             time: identifiers.time,
//             smsBank: identifiers.smsBank
//         });

//         return identifiers;
//     }
    
// static extractTransactionIdentifiers(smsText) {
//     smsText = smsText.trim();
    
//     console.log('🔍 EXTRACTING IDENTIFIERS FOR ALL BANKS');
    
//     const identifiers = {
//         amount: this.extractAmountFromSMS(smsText),
//         transactionId: null,
//         refNumber: null,
//         time: null,
//         senderName: null,
//         recipientName: null,
//         accountNumbers: [],
//         smsBank: this.detectBankFromSMS(smsText),
//         rawRefNumber: null,
//         isCredit: false,
//         isDebit: false,
//         exactAmount: null,
//         cleanRefNumber: null,
//         rawSMS: smsText // Store raw SMS for phone extraction
//     };
    
//     const sms = smsText.toLowerCase();
    
//     // TELEBIRR SPECIFIC EXTRACTION (MORE ROBUST)
//    if (sms.includes(በቴሌብር) || sms.includes('telebirr') || sms.includes('ethio telecom')) {
//         console.log('📱 Processing Telebirr SMS (Amharic/English)...');
//         identifiers.smsBank = 'Telebirr';
        
//         // Extract transaction ID (የሂሳብ እንቅስቃሴ ቁጥርዎ DB22EKVKKW)
//         const txnPatterns = [
//             /የሂሳብ እንቅስቃሴ ቁጥርዎ\s*([A-Z0-9]{8,12})/i,
//             /transaction number is\s*([A-Z0-9]{8,12})/i,
//             /Your transaction number is\s*([A-Z0-9]{8,12})\./i,
//             /receipt\/([A-Z0-9]{8,12})/i,
//             /DB[A-Z0-9]+/i, // DB22EKVKKW pattern
//             /([A-Z0-9]{8,12})/ // General alphanumeric
//         ];
        
//         for (const pattern of txnPatterns) {
//             const match = smsText.match(pattern);
//             if (match && match[1]) {
//                 identifiers.transactionId = match[1].toUpperCase();
//                 identifiers.refNumber = identifiers.transactionId;
//                 console.log('✅ Telebirr transaction ID found:', identifiers.transactionId);
//                 break;
//             }
//         }
        
//         // Extract amount (20.00 ብር)
//         const amountPatterns = [
//             /(\d+\.?\d*)\s*ብር/i,
//             /(\d+\.?\d*)\s*birr/i,
//             /(\d+\.?\d*)\s*ETB/i,
//             /received.*?(\d+\.?\d*)/i,
//             /ተቀብለዋል.*?(\d+\.?\d*)/i
//         ];
        
//         for (const pattern of amountPatterns) {
//             const match = smsText.match(pattern);
//             if (match && match[1]) {
//                 identifiers.exactAmount = parseFloat(match[1]);
//                 identifiers.amount = identifiers.exactAmount;
//                 console.log('💰 Telebirr amount extracted:', identifiers.amount);
//                 break;
//             }
//         }
        
//         // Extract phone number (2519****8285)
//         const phonePatterns = [
//             /\((\d{4}\*\*\*\*\d{4})\)/,
//             /(\+2519\d{8})/,
//             /(2519\d{8})/,
//             /(09\d{8})/
//         ];
        
//         for (const pattern of phonePatterns) {
//             const match = smsText.match(pattern);
//             if (match && match[1]) {
//                 identifiers.senderPhone = match[1];
//                 console.log('📱 Telebirr phone found:', identifiers.senderPhone);
//                 break;
//             }
//         }
        
//         // Extract sender name (DEFAR GOBEZE)
//         const senderMatch = smsText.match(/ከ\s*([A-Za-z\s]+?)\(/i);
//         if (senderMatch) {
//             identifiers.senderName = senderMatch[1].trim();
//             console.log('👤 Telebirr sender name:', identifiers.senderName);
//         }
        
//         // Extract recipient name (Degafi)
//         const recipientMatch = smsText.match(/ውድ\s*([A-Za-z\s]+?)\s*ከ/i);
//         if (recipientMatch) {
//             identifiers.recipientName = recipientMatch[1].trim();
//             console.log('👤 Telebirr recipient name:', identifiers.recipientName);
//         }
        
//         // Extract time (02/02/2026 11:11:50)
//         const timeMatch = smsText.match(/(\d{2}\/\d{2}\/\d{4})\s+(\d{2}:\d{2}:\d{2})/);
//         if (timeMatch) {
//             identifiers.time = `${timeMatch[1]} ${timeMatch[2]}`;
//             console.log('⏰ Telebirr time:', identifiers.time);
//         }
        
//         // Extract new balance (317.00 ብር)
//         const balanceMatch = smsText.match(/ቀሪ ሂሳብ\s*(\d+\.?\d*)\s*ብር/i);
//         if (balanceMatch) {
//             identifiers.newBalance = parseFloat(balanceMatch[1]);
//             console.log('💎 Telebirr new balance:', identifiers.newBalance);
//         }
        
//         // Determine transaction type
//         if (sms.includes('ተቀብለዋል') || sms.includes('received')) {
//             identifiers.isCredit = true;
//             identifiers.direction = 'INCOMING';
//         } else if (sms.includes('sent') || sms.includes('የላኩ')) {
//             identifiers.isDebit = true;
//             identifiers.direction = 'OUTGOING';
//         }
//     }
    
//     // Rest of your existing CBE extraction logic...
//     // ... [keep your existing CBE extraction code]
    
//     return identifiers;
// }
    // ENHANCED: Clean CBE reference by removing account suffix
    static cleanCBEReference(reference) {
        if (!reference) return null;
        
        const ref = reference.toUpperCase();
        
        console.log('🧹 Cleaning CBE reference:', ref);
        
        // Check if it's a CBE FT reference
        if (ref.startsWith('FT')) {
          // CBE format: FT26026HKU6411206342 (20 chars)
          // We want: FT26026HKU64 (12 chars)
          
          if (ref.length >= 20) {
            // Extract first 12 characters (FT + 2 digits + 6 letters/digits)
            const cleanRef = ref.substring(0, 12);
            
            // Verify it looks like a CBE reference: FT + 5 digits + 5 letters/digits
            if (/^FT\d{5}[A-Z0-9]{5}$/.test(cleanRef)) {
              console.log(`✅ Cleaned CBE reference: ${ref} -> ${cleanRef}`);
              return cleanRef;
            }
          }
          
          // For shorter references, just return as-is
          console.log(`✅ CBE reference (no change): ${ref}`);
          return ref;
        }
        
        // Not a CBE reference
        console.log(`✅ Not a CBE FT reference: ${ref}`);
        return ref;
      }
    static async cleanupDuplicateReferences() {
        try {
          console.log('🧹 Cleaning up duplicate references...');
          
          const duplicates = await SMSDeposit.aggregate([
            {
              $match: {
                extractedReference: { $exists: true, $ne: null }
              }
            },
            {
              $group: {
                _id: '$extractedReference',
                count: { $sum: 1 },
                ids: { $push: '$_id' },
                types: { $push: '$smsType' }
              }
            },
            {
              $match: {
                count: { $gt: 2 } // More than 2 SMS with same reference
              }
            }
          ]);
          
          console.log(`Found ${duplicates.length} duplicate reference groups`);
          
          const cleanupResults = [];
          
          for (const dup of duplicates) {
            // Keep only one SENDER and one RECEIVER per reference
            const smsList = await SMSDeposit.find({ _id: { $in: dup.ids } });
            
            const senders = smsList.filter(s => s.smsType === 'SENDER');
            const receivers = smsList.filter(s => s.smsType === 'RECEIVER');
            
            // Mark extras for deletion
            const toDelete = [];
            
            if (senders.length > 1) {
              senders.slice(1).forEach(s => toDelete.push(s._id));
            }
            
            if (receivers.length > 1) {
              receivers.slice(1).forEach(s => toDelete.push(s._id));
            }
            
            if (toDelete.length > 0) {
              await SMSDeposit.deleteMany({ _id: { $in: toDelete } });
              cleanupResults.push({
                reference: dup._id,
                deleted: toDelete.length,
                kept: smsList.length - toDelete.length
              });
            }
          }
          
          console.log(`✅ Cleanup completed. Results:`, cleanupResults);
          return cleanupResults;
          
        } catch (error) {
          console.error('❌ Error cleaning up duplicate references:', error);
          throw error;
        }
      }
    // NEW: Helper method to clean CBE reference by removing account suffix
    static cleanCBEReference(reference) {
      if (!reference) return null;
      
      const ref = reference.toUpperCase();
      
      console.log(`🧹 Cleaning reference: ${ref}`);
      
      // Check if it's a Telebirr reference (alphanumeric, no FT prefix)
      if (!ref.startsWith('FT') && /^[A-Z0-9]{8,12}$/.test(ref)) {
        console.log(`📱 Telebirr reference detected: ${ref}`);
        return ref; // Telebirr references don't need cleaning
      }
      
      // CBE reference handling (original logic)
      if (ref.startsWith('FT')) {
        if (ref.length >= 12) {
          const last8 = ref.slice(-8);
          if (/^\d{8}$/.test(last8)) {
            const cleanRef = ref.slice(0, -8);
            console.log(`✅ Removed 8-digit account suffix: ${ref} -> ${cleanRef}`);
            return cleanRef;
          } else {
            console.log(`✅ No account suffix found: ${ref}`);
            return ref;
          }
        } else {
          console.log(`✅ Reference too short for suffix: ${ref}`);
          return ref;
        }
      }
      
      console.log(`✅ Not a CBE/Telebirr reference: ${ref}`);
      return ref;
    }
    static calculateCBE_MatchScore(sms1Identifiers, sms2Deposit) {
        let score = 0;
        const maxScore = 100;
        
        console.log('📊 CALCULATING CBE MATCH SCORE');
        
        const sms2Text = sms2Deposit.originalSMS;
        const sms2Identifiers = this.extractTransactionIdentifiers(sms2Text);
        
        console.log('SMS1 Bank:', sms1Identifiers.smsBank);
        console.log('SMS2 Bank:', sms2Identifiers.smsBank);
        console.log('SMS1 Type:', sms1Identifiers.isCredit ? 'CREDIT' : sms1Identifiers.isDebit ? 'DEBIT' : 'UNKNOWN');
        console.log('SMS2 Type:', sms2Identifiers.isCredit ? 'CREDIT' : sms2Identifiers.isDebit ? 'DEBIT' : 'UNKNOWN');
        console.log('SMS1 Amount:', sms1Identifiers.exactAmount || sms1Identifiers.amount);
        console.log('SMS2 Amount:', sms2Deposit.extractedAmount);
        console.log('SMS1 Clean Ref:', sms1Identifiers.cleanRefNumber);
        console.log('SMS2 Clean Ref:', sms2Deposit.extractedReference);
        
        // 1. Check if they're opposite types (one debit, one credit) - 25 points
        const isOppositeType = (sms1Identifiers.isDebit && sms2Identifiers.isCredit) || 
                              (sms1Identifiers.isCredit && sms2Identifiers.isDebit);
        
        if (isOppositeType) {
          score += 25;
          console.log('✅ Opposite transaction types (CBE debit vs credit)');
        } else {
          console.log('❌ Same transaction type - not a match');
          return 0;
        }
        
        // 2. Amount match (30 points) - Must be exact for CBE
        if (sms1Identifiers.exactAmount) {
          if (sms1Identifiers.exactAmount === sms2Deposit.extractedAmount) {
            score += 30;
            console.log('✅ Exact CBE amount match');
          } else {
            console.log('⚠️ CBE amount mismatch');
            return 0;
          }
        } else if (sms1Identifiers.amount) {
          if (Math.abs(sms1Identifiers.amount - sms2Deposit.extractedAmount) < 0.01) {
            score += 30;
            console.log('✅ Amount match');
          } else {
            console.log('⚠️ Amount mismatch');
            return 0;
          }
        }
        
        // 3. CBE Reference match (35 points) - Most important for CBE
        if (sms1Identifiers.cleanRefNumber && sms2Deposit.extractedReference) {
          const ref1 = sms1Identifiers.cleanRefNumber.toUpperCase();
          const ref2 = sms2Deposit.extractedReference.toUpperCase();
          
          console.log('🔑 Comparing CBE references:', ref1, 'vs', ref2);
          
          // Exact match
          if (ref1 === ref2) {
            score += 35;
            console.log('✅ Exact CBE reference match');
          }
          // Partial match (one contains the other)
          else if (ref1.includes(ref2) || ref2.includes(ref1)) {
            score += 32;
            console.log('✅ Partial CBE reference match');
          }
          // Match first part (FT26026HKU64 vs FT26026HKU6411206342)
          else if (ref1.length === 12 && ref2.length >= 20) {
            if (ref2.startsWith(ref1)) {
              score += 35;
              console.log('✅ CBE base reference match (with suffix)');
            } else {
              console.log('⚠️ CBE reference mismatch');
              return 0;
            }
          } else if (ref2.length === 12 && ref1.length >= 20) {
            if (ref1.startsWith(ref2)) {
              score += 35;
              console.log('✅ CBE base reference match (with suffix)');
            } else {
              console.log('⚠️ CBE reference mismatch');
              return 0;
            }
          } else {
            console.log('⚠️ CBE reference mismatch');
            return 0;
          }
        } else {
          console.log('⚠️ Missing CBE reference');
          return 0;
        }
        
        // 4. Time match (5 points) - within 5 minutes
        if (sms1Identifiers.time && sms2Deposit.createdAt) {
          const time1 = this.parseCBE_Time(sms1Identifiers.time);
          const time2 = sms2Deposit.createdAt;
          
          if (time1 && time2) {
            const timeDiff = Math.abs(time1.getTime() - time2.getTime());
            if (timeDiff <= 5 * 60 * 1000) { // 5 minutes
              score += 5;
              console.log('✅ CBE time match within 5 minutes');
            }
          }
        }
        
        // 5. Name correlation (5 points)
        if (sms1Identifiers.senderName && sms2Deposit.metadata?.recipientName) {
          if (this.namesAreSimilar(sms1Identifiers.senderName, sms2Deposit.metadata.recipientName)) {
            score += 5;
            console.log('✅ CBE names correlate');
          }
        } else if (sms1Identifiers.recipientName && sms2Deposit.metadata?.senderName) {
          if (this.namesAreSimilar(sms1Identifiers.recipientName, sms2Deposit.metadata.senderName)) {
            score += 5;
            console.log('✅ CBE names correlate');
          }
        }
        
        const percentage = (score / maxScore) * 100;
        console.log(`📈 CBE Match percentage: ${percentage}% (${score}/${maxScore})`);
        
        return percentage / 100;
      }
      // NEW: Parse CBE time format
      static parseCBE_Time(timeString) {
        try {
          // CBE format: "25/01/2026 20:17:15"
          const parts = timeString.split(' ');
          if (parts.length === 2) {
            const [datePart, timePart] = parts;
            return new Date(`${datePart} ${timePart}`);
          }
          return null;
        } catch (error) {
          console.error('Error parsing CBE time:', error);
          return null;
        }
      }
    // Add this helper method
    static extractCBEReferenceFromSMS(smsText) {
      console.log('🔍 Attempting CBE-specific reference extraction');
      
      // Method 1: Direct URL pattern extraction
      const urlPattern = /(?:https?:\/\/apps\.cbe\.com\.et(?::\d+)?\/\?id=|id=)([A-Z0-9]+)/i;
      const urlMatch = smsText.match(urlPattern);
      
      if (urlMatch && urlMatch[1]) {
        const fullId = urlMatch[1];
        console.log('🔍 Found CBE URL reference:', fullId);
        
        // CBE typically has pattern: FT + digits + letters + 8 digit account suffix
        // Example: FT253422RPRW11206342
        
        // Look for FT pattern
        const ftPattern = /(FT\d+[A-Z]+)/i;
        const ftMatch = fullId.match(ftPattern);
        
        if (ftMatch) {
          console.log('✅ Extracted CBE FT reference:', ftMatch[1]);
          return ftMatch[1];
        }
        
        // If no FT pattern, remove last 8 digits (account suffix)
        if (fullId.length >= 12) {
          const baseRef = fullId.substring(0, fullId.length - 8);
          if (baseRef.length >= 8) {
            console.log('✅ Extracted by removing account suffix:', baseRef);
            return baseRef;
          }
        }
        
        return fullId;
      }
      
      // Method 2: Standard Ref No pattern
      const refPattern = /Ref\s*No\s*([A-Z0-9]+)/i;
      const refMatch = smsText.match(refPattern);
      
      if (refMatch && refMatch[1]) {
        console.log('✅ Found standard Ref No:', refMatch[1]);
        return refMatch[1];
      }
      
      // Method 3: FT pattern anywhere in text
      const ftAnywhere = smsText.match(/(FT\d+[A-Z]+)/i);
      if (ftAnywhere && ftAnywhere[1]) {
        console.log('✅ Found FT pattern in text:', ftAnywhere[1]);
        return ftAnywhere[1];
      }
      
      return null;
    }
    // Also need to update the calculateSMSMatchScore method to handle partial matches better:
    static calculateSMSMatchScore(sms1Identifiers, sms2Deposit) {
      let score = 0;
      const maxScore = 100;
      
      const sms2Text = sms2Deposit.originalSMS;
      const sms2Identifiers = this.extractTransactionIdentifiers(sms2Text);
      
      console.log('📊 COMPARING SMS FOR MATCHING:');
      console.log('SMS1 Bank:', sms1Identifiers.smsBank);
      console.log('SMS2 Bank:', sms2Identifiers.smsBank);
      console.log('SMS1 Type:', sms1Identifiers.isCredit ? 'CREDIT' : sms1Identifiers.isDebit ? 'DEBIT' : 'UNKNOWN');
      console.log('SMS2 Type:', sms2Identifiers.isCredit ? 'CREDIT' : sms2Identifiers.isDebit ? 'DEBIT' : 'UNKNOWN');
      console.log('SMS1 Amount:', sms1Identifiers.amount, 'Exact:', sms1Identifiers.exactAmount);
      console.log('SMS2 Amount:', sms2Deposit.extractedAmount);
      console.log('SMS1 Ref:', sms1Identifiers.refNumber);
      console.log('SMS2 Ref:', sms2Deposit.extractedReference);
      
      // 1. Check if they're opposite types (one debit, one credit) - 20 points
      const isOppositeType = (sms1Identifiers.isDebit && sms2Identifiers.isCredit) || 
                            (sms1Identifiers.isCredit && sms2Identifiers.isDebit);
      
      if (isOppositeType) {
        score += 20;
        console.log('✅ Opposite transaction types (debit vs credit)');
      } else {
        console.log('❌ Same transaction type - not a match');
        return 0;
      }

      // 2. Amount match (30 points) - Use stored extractedAmount
      if (sms1Identifiers.exactAmount) {
        if (sms1Identifiers.exactAmount === sms2Deposit.extractedAmount) {
          score += 30;
          console.log('✅ Exact amount match');
        } else {
          console.log('⚠️ Amount mismatch');
          return 0;
        }
      } else if (sms1Identifiers.amount) {
        if (Math.abs(sms1Identifiers.amount - sms2Deposit.extractedAmount) < 0.01) {
          score += 30;
          console.log('✅ Amount match');
        } else {
          console.log('⚠️ Amount mismatch');
          return 0;
        }
      }
      
      // 3. Reference match (30 points) - For Telebirr, exact match is required
      if (sms1Identifiers.refNumber && sms2Deposit.extractedReference) {
        const ref1 = sms1Identifiers.refNumber.toUpperCase();
        const ref2 = sms2Deposit.extractedReference.toUpperCase();
        
        // Exact match (especially important for Telebirr)
        if (ref1 === ref2) {
          score += 30;
          console.log('✅ Exact reference number match');
        } 
        // For Telebirr, don't allow partial matches - must be exact
        else if (sms1Identifiers.smsBank === 'Telebirr' || sms2Identifiers.smsBank === 'Telebirr') {
          console.log('⚠️ Telebirr references must match exactly');
          return 0;
        }
        // For CBE, allow partial matches
        else if (ref1.includes(ref2) || ref2.includes(ref1)) {
          score += 28;
          console.log('✅ Partial reference match (CBE)');
        } else {
          console.log('⚠️ Reference number mismatch');
          return 0;
        }
      } else if (!sms1Identifiers.refNumber && !sms2Deposit.extractedReference) {
        // No references, allow matching based on other factors (15 points)
        score += 15;
        console.log('ℹ️ No reference numbers, matching on other factors');
      } else {
        console.log('⚠️ Missing reference number');
        return 0;
      }
      
      // 4. Time match (10 points) - within 5 minutes
      if (sms1Identifiers.time && sms2Deposit.createdAt) {
        const time1 = this.parseSMSTime(sms1Identifiers.time);
        const time2 = sms2Deposit.createdAt;
        
        if (time1 && time2) {
          const timeDiff = Math.abs(time1.getTime() - time2.getTime());
          if (timeDiff <= 5 * 60 * 1000) { // 5 minutes
            score += 10;
            console.log('✅ Time match within 5 minutes');
          } else if (timeDiff <= 10 * 60 * 1000) { // 10 minutes
            score += 5;
            console.log('⏰ Time within 10 minutes');
          }
        }
      }
      
      // 5. Bank match (5 points)
      if (sms1Identifiers.smsBank && sms2Deposit.paymentMethod) {
        const bank1 = sms1Identifiers.smsBank.toLowerCase();
        const bank2 = sms2Deposit.paymentMethod.toLowerCase();
        
        if (bank2.includes(bank1) || bank1.includes(bank2)) {
          score += 5;
          console.log('✅ Bank match');
        }
      }
      
      // 6. Name correlation (5 points)
      if (sms1Identifiers.senderName && sms2Deposit.metadata?.recipientName) {
        if (this.namesAreSimilar(sms1Identifiers.senderName, sms2Deposit.metadata.recipientName)) {
          score += 5;
          console.log('✅ Names correlate');
        }
      }
      
      const percentage = (score / maxScore) * 100;
      console.log(`📈 Match percentage: ${percentage}% (${score}/${maxScore})`);
      
      return percentage / 100;
    }
      

    // Add a helper method to better parse CBE URL references:
    static extractCBEReferenceFromURL(urlPart) {
      // Extract from pattern: id=FT253422RPRW11206342
      const match = urlPart.match(/id=([A-Z0-9]+)/i);
      if (!match) return null;
      
      const fullId = match[1];
      
      // CBE pattern: Usually 12-13 chars reference + 8 chars account suffix
      if (fullId.length >= 20) { // FT253422RPRW11206342 = 20 chars
        // The reference is first 12-13 characters
        return fullId.substring(0, 12); // Usually FT253422RPRW
      } else if (fullId.length >= 12) {
        // If shorter, try to find FT pattern
        const ftMatch = fullId.match(/(FT\d+[A-Z]+)/i);
        return ftMatch ? ftMatch[1] : fullId.substring(0, 12);
      }
      
      return fullId;
    }
      static detectBankFromSMS(smsText) {
    const sms = smsText.toLowerCase();
    
    if (sms.includes('ቴሌብር')||sms.includes('በቴሌብር') || sms.includes('telebirr') || sms.includes('ethio telecom') || sms.includes('ethiotelecom')) {
        return 'Telebirr';
    }
    if (sms.includes('cbe') && !sms.includes('telebirr') && !sms.includes('በቴሌብር')) {
        return 'CBE';
    }
    if ( sms.includes('abysinia')) {
        return 'BOA';
    }
    if (sms.includes('dashen')) {
        return 'Dashen';
    }
    if (sms.includes('ንብ') || sms.includes('nib')) {
        return 'NIB';
    }
    if (sms.includes('ህብረት') || sms.includes('hibret')) {
        return 'Hibret';
    }
    
    return 'UNKNOWN';
}
    // NEW: Try to auto-match SMS with existing ones

    // NEW: Calculate match score between two SMS
    static calculateSMSMatchScore(sms1Identifiers, sms2Deposit) {
      let score = 0;
      const maxScore = 100;
      
      // Get second SMS identifiers
      const sms2Text = sms2Deposit.originalSMS;
      const sms2Identifiers = this.extractTransactionIdentifiers(sms2Text);
      
      console.log('📊 Comparing SMS identifiers:');
      console.log('SMS1 Type:', sms1Identifiers.isCredit ? 'CREDIT' : sms1Identifiers.isDebit ? 'DEBIT' : 'UNKNOWN');
      console.log('SMS2 Type:', sms2Identifiers.isCredit ? 'CREDIT' : sms2Identifiers.isDebit ? 'DEBIT' : 'UNKNOWN');
      console.log('SMS1 Amount:', sms1Identifiers.amount, 'Exact:', sms1Identifiers.exactAmount);
      console.log('SMS2 Amount:', sms2Identifiers.amount, 'Exact:', sms2Identifiers.exactAmount);
      console.log('SMS1 Ref:', sms1Identifiers.refNumber, 'Raw:', sms1Identifiers.rawRefNumber);
      console.log('SMS2 Ref:', sms2Identifiers.refNumber, 'Raw:', sms2Identifiers.rawRefNumber);
      
      // 1. Check if they're opposite types (one debit, one credit) - 20 points
      if ((sms1Identifiers.isDebit && sms2Identifiers.isCredit) || 
          (sms1Identifiers.isCredit && sms2Identifiers.isDebit)) {
        score += 20;
        console.log('✅ Opposite transaction types');
      } else {
        console.log('❌ Same transaction type - not a match');
        return 0; // Early exit if both are same type
      }
      
      // 2. Amount match (30 points) - Must be exact for CBE
      if (sms1Identifiers.exactAmount && sms2Identifiers.exactAmount) {
        if (sms1Identifiers.exactAmount === sms2Identifiers.exactAmount) {
          score += 30;
          console.log('✅ Exact amount match');
        } else {
          console.log('⚠️ Amount mismatch');
          return 0; // Early exit for amount mismatch
        }
      } else if (sms1Identifiers.amount && sms2Identifiers.amount) {
        // Fallback to regular amount extraction
        if (Math.abs(sms1Identifiers.amount - sms2Identifiers.amount) < 0.01) {
          score += 30;
          console.log('✅ Amount match');
        } else {
          console.log('⚠️ Amount mismatch');
          return 0;
        }
      }
      
      // 3. Transaction/Ref number match (30 points) - Handle partial matches
      if (sms1Identifiers.refNumber && sms2Identifiers.refNumber) {
        const ref1 = sms1Identifiers.refNumber.toUpperCase();
        const ref2 = sms2Identifiers.refNumber.toUpperCase();
        
        // Exact match
        if (ref1 === ref2) {
          score += 30;
          console.log('✅ Exact reference number match');
        } 
        // Partial match - one contains the other
        else if (ref1.includes(ref2) || ref2.includes(ref1)) {
          score += 25;
          console.log('✅ Partial reference match (one contains other)');
        }
        // Match first part (FT253422RPRW vs FT253422RPRW11206342)
        else if (sms1Identifiers.rawRefNumber && sms2Identifiers.rawRefNumber) {
          const raw1 = sms1Identifiers.rawRefNumber.toUpperCase();
          const raw2 = sms2Identifiers.rawRefNumber.toUpperCase();
          
          if (raw1.includes(ref2) || raw2.includes(ref1)) {
            score += 25;
            console.log('✅ Raw reference match');
          } else {
            // Try to extract common base reference
            const baseRef1 = ref1.replace(/\d{7,8}$/, '');
            const baseRef2 = ref2.replace(/\d{7,8}$/, '');
            
            if (baseRef1 && baseRef2 && baseRef1 === baseRef2) {
              score += 28;
              console.log('✅ Base reference match (after cleanup)');
            } else {
              console.log('⚠️ Reference number mismatch');
              return 0;
            }
          }
        } else {
          console.log('⚠️ Reference number mismatch');
          return 0;
        }
      }
      
      // 4. Time match (10 points) - within 5 minutes
      if (sms1Identifiers.time && sms2Identifiers.time) {
        const time1 = this.parseSMSTime(sms1Identifiers.time);
        const time2 = this.parseSMSTime(sms2Identifiers.time);
        
        if (time1 && time2) {
          const timeDiff = Math.abs(time1.getTime() - time2.getTime());
          if (timeDiff <= 5 * 60 * 1000) { // 5 minutes
            score += 10;
            console.log('✅ Time match within 5 minutes');
          } else if (timeDiff <= 10 * 60 * 1000) { // 10 minutes
            score += 5;
            console.log('⏰ Time within 10 minutes');
          }
        }
      }
      
      // 5. Bank match (5 points)
      if (sms1Identifiers.smsBank && sms2Identifiers.smsBank) {
        if (sms1Identifiers.smsBank === sms2Identifiers.smsBank) {
          score += 5;
          console.log('✅ Bank match');
        }
      }
      
      // 6. Name correlation (5 points)
      if (sms1Identifiers.senderName && sms2Identifiers.recipientName) {
        if (this.namesAreSimilar(sms1Identifiers.senderName, sms2Identifiers.recipientName)) {
          score += 5;
          console.log('✅ Names correlate');
        }
      }
      
      const percentage = (score / maxScore) * 100;
      console.log(`📈 Match percentage: ${percentage}% (${score}/${maxScore})`);
      
      return percentage / 100;
    }
    // NEW: Enhanced CBE matching logic
static async matchCBE_SMS(newSMSDeposit, smsText) {
    try {
        const newAnalysis = this.analyzeSMSType(smsText);
        const newIdentifiers = this.extractTransactionIdentifiers(smsText);
        
        console.log('🔍 CBE SMS Matching Process - CHECK BEFORE SAVING');
        console.log('SMS Type:', newAnalysis.type);
        console.log('Amount:', newSMSDeposit.extractedAmount);
        console.log('Reference:', newSMSDeposit.extractedReference);
        console.log('Clean Reference:', newIdentifiers.cleanRefNumber);
        
        if (!newSMSDeposit.extractedAmount || newSMSDeposit.extractedAmount <= 0) {
            console.log('⚠️ No valid amount, cannot match CBE SMS');
            return null;
        }
        
        // Step 1: Check for existing high-confidence matches BEFORE updating the SMS
        const oppositeType = newAnalysis.type === 'SENDER' ? 'RECEIVER' : 'SENDER';
        
        const query = {
            _id: { $ne: newSMSDeposit._id },
            status: { $in: ['RECEIVED', 'RECEIVED_WAITING_MATCH', 'PENDING'] },
            smsType: oppositeType,
            extractedAmount: newSMSDeposit.extractedAmount,
            paymentMethod: { $regex: /CBE/i },
            createdAt: { 
                $gte: new Date(Date.now() - 24 * 60 * 60 * 1000)
            }
        };
        
        // Add reference to query if available
        const reference = newSMSDeposit.extractedReference || newIdentifiers.cleanRefNumber;
        if (reference) {
            query.$or = [
                { extractedReference: reference },
                { 'metadata.cleanReference': reference },
                { 'metadata.rawReference': reference }
            ];
            console.log(`🔑 Checking for existing matches with reference: ${reference}`);
        }
        
        console.log('🔍 Pre-save match query:', JSON.stringify(query, null, 2));
        
        const potentialMatches = await SMSDeposit.find(query)
            .populate('userId', 'firstName username telegramId')
            .sort({ createdAt: -1 })
            .limit(10);
        
        console.log(`🔍 Found ${potentialMatches.length} potential CBE matches to check`);
        
        // Check each potential match for high confidence
        for (const potentialMatch of potentialMatches) {
            const matchScore = this.calculateCBE_MatchScore(newIdentifiers, potentialMatch);
            console.log(`📊 Match score with ${potentialMatch._id}: ${matchScore}`);
            
            if (matchScore >= 0.85) { // High confidence match
                console.log(`✅ HIGH CONFIDENCE CBE MATCH FOUND (${matchScore})!`);
                
                // Update the new SMS with analysis info
                newSMSDeposit.smsType = newAnalysis.type;
                newSMSDeposit.paymentMethod = 'CBE Bank';
                newSMSDeposit.metadata.transactionIdentifiers = newIdentifiers;
                newSMSDeposit.metadata.bank = 'CBE';
                newSMSDeposit.metadata.cleanReference = newIdentifiers.cleanRefNumber;
                
                // Save the new SMS first
                await newSMSDeposit.save();
                
                // Determine which is user SMS and which is admin SMS
                let userSMS, adminSMS;
                if (newAnalysis.type === 'SENDER') {
                    userSMS = newSMSDeposit;
                    adminSMS = potentialMatch;
                } else {
                    userSMS = potentialMatch;
                    adminSMS = newSMSDeposit;
                }
                
                // Use the existing approveCBE_MatchedSMS method
                try {
                    const result = await this.approveCBE_MatchedSMS(userSMS, adminSMS);
                    console.log('✅ CBE transaction auto-approved and deposited!');
                    return result;
                } catch (approvalError) {
                    console.error('❌ Error auto-approving CBE match:', approvalError);
                    // Continue to next potential match
                    continue;
                }
            }
        }
        
        // Step 2: If no high-confidence match found, update and save normally
        console.log('❌ No high-confidence matches found. Updating SMS normally...');
        
        newSMSDeposit.smsType = newAnalysis.type;
        newSMSDeposit.metadata.transactionIdentifiers = newIdentifiers;
        
        // Update reference if needed
        if (!newSMSDeposit.extractedReference && newIdentifiers.cleanRefNumber) {
            newSMSDeposit.extractedReference = newIdentifiers.cleanRefNumber;
            console.log(`💾 Saved reference: ${newIdentifiers.cleanRefNumber}`);
        }
        
        newSMSDeposit.status = 'RECEIVED_WAITING_MATCH';
        newSMSDeposit.metadata.matchingAttempted = true;
        newSMSDeposit.metadata.matchScore = 0; // No match found
        newSMSDeposit.metadata.bank = 'CBE';
        newSMSDeposit.metadata.cleanReference = newIdentifiers.cleanRefNumber;
        
        await newSMSDeposit.save();
        
        // Schedule batch matching for later
        setTimeout(async () => {
            try {
                console.log('🔄 Running delayed batch matching for CBE...');
                await this.batchMatchCBE_SMS();
            } catch (error) {
                console.error('❌ Error in delayed CBE batch matching:', error);
            }
        }, 3000);
        
        return null;
        
    } catch (error) {
        console.error('❌ Error in CBE matching:', error);
        
        // Fallback
        try {
            newSMSDeposit.status = 'RECEIVED';
            newSMSDeposit.metadata.cbeMatchingError = error.message;
            await newSMSDeposit.save();
        } catch (saveError) {
            console.error('❌ Could not save CBE SMS deposit:', saveError);
        }
        
        return null;
    }
}

    // NEW: CBE cross-matching (try to match any CBE SMS with same reference)
    static async tryCBE_CrossMatch(smsDeposit, identifiers) {
        try {
            if (!identifiers.cleanRefNumber) return null;
            
            console.log('🔄 Attempting aggressive CBE cross-match...');
            
            const query = {
                _id: { $ne: smsDeposit._id },
                status: { $in: ['RECEIVED', 'RECEIVED_WAITING_MATCH', 'PENDING'] },
                paymentMethod: { $regex: /CBE/i },
                extractedAmount: smsDeposit.extractedAmount,
                $or: [
                    { extractedReference: identifiers.cleanRefNumber },
                    { extractedReference: { $regex: `^${identifiers.cleanRefNumber}` } },
                    { 'metadata.cleanReference': identifiers.cleanRefNumber }
                ],
                createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } // Last 24 hours
            };
            
            const matches = await SMSDeposit.find(query)
                .populate('userId', 'firstName username telegramId')
                .sort({ createdAt: -1 })
                .limit(5);
            
            console.log(`🔍 Found ${matches.length} possible cross-matches`);
            
            for (const match of matches) {
                // Don't match same type
                if (match.smsType === smsDeposit.smsType) continue;
                
                const matchScore = this.calculateCBE_MatchScore(identifiers, match);
                console.log(`📊 CBE cross-match score with ${match._id}: ${matchScore}`);
                
                if (matchScore >= 0.85) { // 85% confidence
                    console.log(`✅ CBE cross-match found with ${match._id}: ${matchScore}`);
                    
                    // Determine which is user SMS and which is admin SMS
                    let userSMS, adminSMS;
                    if (smsDeposit.smsType === 'SENDER') {
                        userSMS = smsDeposit;
                        adminSMS = match;
                    } else {
                        userSMS = match;
                        adminSMS = smsDeposit;
                    }
                    
                    return await this.approveCBE_MatchedSMS(userSMS, adminSMS);
                }
            }
            
            return null;
        } catch (error) {
            console.error('❌ Error in CBE cross-match:', error);
            return null;
        }
    }
      // NEW: Approve matched CBE SMS
    static async approveCBE_MatchedSMS(senderSMS, receiverSMS) {
        const session = await mongoose.startSession();
        session.startTransaction();
        
        try {
            console.log('✅ Approving matched CBE SMS pair and depositing to wallet...');
            
            // Determine which is sender and which is receiver
            let userSMS, adminSMS;
            if (senderSMS.smsType === 'SENDER') {
                userSMS = senderSMS;
                adminSMS = receiverSMS;
            } else {
                userSMS = receiverSMS;
                adminSMS = senderSMS;
            }
            
            const user = await User.findById(userSMS.userId).session(session);
            if (!user) throw new Error('User not found for matched CBE SMS');
            
            const amount = userSMS.extractedAmount;
            const reference = userSMS.extractedReference || userSMS.metadata?.cleanReference;
            
            console.log(`💰 Processing CBE deposit: $${amount} for user ${user.telegramId} (Ref: ${reference})`);
            
            // Get or create wallet
            let wallet = await Wallet.findOne({ userId: user._id }).session(session);
            if (!wallet) {
                wallet = new Wallet({
                    userId: user._id,
                    balance: 0,
                    currency: 'USD'
                });
            }
            
            const balanceBefore = wallet.balance;
            wallet.balance += amount;
            const balanceAfter = wallet.balance;
            
            console.log(`💰 Wallet updated: $${balanceBefore} -> $${balanceAfter}`);
            
            // Create transaction
            const transaction = new Transaction({
                userId: user._id,
                type: 'DEPOSIT',
                amount,
                balanceBefore,
                balanceAfter,
                status: 'COMPLETED',
                description: `CBE deposit auto-approved via SMS matching (Ref: ${reference})`,
                reference: `CBE-AUTO-${reference || Date.now()}`,
                metadata: {
                    paymentMethod: 'CBE Bank',
                    autoMatched: true,
                    matchedType: 'CBE_AUTO',
                    cbeReference: reference,
                    senderSMSId: userSMS._id,
                    receiverSMSId: adminSMS._id,
                    matchedAt: new Date(),
                    confidence: this.calculateCBE_MatchScore(
                        this.extractTransactionIdentifiers(userSMS.originalSMS),
                        this.extractTransactionIdentifiers(adminSMS.originalSMS)
                    )
                }
            });
            
            // Update SMS deposits
            userSMS.status = 'AUTO_APPROVED';
            userSMS.transactionId = transaction._id;
            userSMS.autoApproved = true;
            userSMS.processedAt = new Date();
            userSMS.metadata.matched = true;
            userSMS.metadata.matchedWith = adminSMS._id;
            userSMS.metadata.matchedReference = reference;
            userSMS.metadata.autoApprovedAt = new Date();
            
            adminSMS.status = 'CONFIRMED';
            adminSMS.metadata.matched = true;
            adminSMS.metadata.matchedWith = userSMS._id;
            adminSMS.metadata.confirmedAmount = amount;
            adminSMS.metadata.confirmedReference = reference;
            adminSMS.metadata.confirmedAt = new Date();
            
            // Save all changes
            await transaction.save({ session });
            await wallet.save({ session });
            await userSMS.save({ session });
            await adminSMS.save({ session });
            
            await session.commitTransaction();
            
            console.log(`✅ CBE deposit COMPLETED: $${amount} added to user ${user.telegramId}'s wallet`);
            
            return {
                transaction,
                wallet,
                userSMS,
                adminSMS,
                autoApproved: true,
                cbeReference: reference,
                amount,
                user
            };
            
        } catch (error) {
            await session.abortTransaction();
            console.error('❌ Error approving CBE matched SMS:', error);
            throw error;
        } finally {
            session.endSession();
        }
    }








      // ENHANCED: Approve matched SMS
    static async approveMatchedSMS(senderSMS, receiverSMS, adminUserId = null) {
      const session = await mongoose.startSession();
      let transactionCompleted = false;

      try {
        console.log('🤖 Approving matched SMS pair...');
        
        session.startTransaction();
        
        // Determine which is sender (user) and which is receiver (admin)
        let userSMS, adminSMS;
        if (senderSMS.smsType === 'SENDER') {
          userSMS = senderSMS;
          adminSMS = receiverSMS;
        } else {
          userSMS = receiverSMS;
          adminSMS = senderSMS;
        }
        
        // Get user from user SMS
        const user = await User.findById(userSMS.userId).session(session);
        if (!user) {
          throw new Error('User not found for matched SMS');
        }
        
        const amount = userSMS.extractedAmount;
        
        // Get or create wallet
        let wallet = await Wallet.findOne({ userId: user._id }).session(session);
        if (!wallet) {
          wallet = new Wallet({
            userId: user._id,
            balance: 0,
            currency: 'USD'
          });
        }
        
        const balanceBefore = wallet.balance;
        wallet.balance += amount;
        const balanceAfter = wallet.balance;
        
        // Create transaction
        const transaction = new Transaction({
          userId: user._id,
          type: 'DEPOSIT',
          amount,
          balanceBefore,
          balanceAfter,
          status: 'COMPLETED',
          description: `Matched deposit via ${userSMS.paymentMethod} (CBE Transfer)`,
          reference: `SMS-MATCHED-${Date.now()}`,
          metadata: {
            paymentMethod: userSMS.paymentMethod,
            autoMatched: true,
            matchedPair: {
              senderSMSId: userSMS._id,
              receiverSMSId: adminSMS._id,
              transactionId: userSMS.metadata?.transactionId,
              matchedAt: new Date()
            }
          }
        });
        
        // Update both SMS deposits
        userSMS.status = 'APPROVED';
        userSMS.transactionId = transaction._id;
        userSMS.autoApproved = true;
        userSMS.processedAt = new Date();
        userSMS.metadata.matched = true;
        userSMS.metadata.matchedWith = adminSMS._id;
        userSMS.metadata.approvedAt = new Date();
        
        adminSMS.status = 'CONFIRMED';
        adminSMS.metadata.matched = true;
        adminSMS.metadata.matchedWith = userSMS._id;
        adminSMS.metadata.confirmedAmount = amount;
        adminSMS.metadata.confirmedAt = new Date();
        
        // If adminUserId is provided, resolve it properly
        if (adminUserId) {
          try {
            const adminUser = await this.resolveUserId(adminUserId);
            userSMS.processedBy = adminUser;
            userSMS.metadata.forceMatchedBy = adminUser;
            console.log(`👤 Force matched by admin: ${adminUserId} -> ${adminUser}`);
          } catch (resolveError) {
            console.warn(`⚠️ Could not resolve admin user ${adminUserId}:`, resolveError.message);
            // Still continue with the approval
          }
        }
        
        await transaction.save({ session });
        await wallet.save({ session });
        await userSMS.save({ session });
        await adminSMS.save({ session });
        
        await session.commitTransaction();
        transactionCompleted = true;
        
        console.log(`✅ Approved matched deposit: $${amount} for user ${user.telegramId}`);
        
        return {
          transaction,
          wallet,
          userSMS,
          adminSMS,
          autoApproved: true
        };
        
      } catch (error) {
        if (!transactionCompleted && session) {
          try {
            await session.abortTransaction();
          } catch (abortError) {
            console.warn('⚠️ Could not abort transaction:', abortError.message);
          }
        }
        
        console.error('❌ Error approving matched SMS:', error);
        throw error;
      } finally {
        if (session) {
          session.endSession();
        }
      }
    }





    ///
    // NEW: Add retry logic for write conflicts
    static async withRetry(operation, maxRetries = 3, delay = 1000) {
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          return await operation();
        } catch (error) {
          // Check if it's a write conflict error
          if (error.code === 112 || error.codeName === 'WriteConflict') {
            console.warn(`⚠️ Write conflict (attempt ${attempt}/${maxRetries}), retrying...`);
            if (attempt < maxRetries) {
              await new Promise(resolve => setTimeout(resolve, delay * attempt));
              continue;
            }
          }
          throw error;
        }
      }
    }

    // Use it in critical operations like:
    static async approveMatchedSMSWithRetry(senderSMS, receiverSMS, maxRetries = 3, delay = 1000) {
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          return await this.approveMatchedSMS(senderSMS, receiverSMS);
        } catch (error) {
          // Check if it's a write conflict error
          if (error.code === 112 || error.codeName === 'WriteConflict') {
            console.warn(`⚠️ Write conflict (attempt ${attempt}/${maxRetries}), retrying...`);
            if (attempt < maxRetries) {
              await new Promise(resolve => setTimeout(resolve, delay * attempt));
              continue;
            }
          }
          
          // For other errors, just throw immediately
          console.error(`❌ Error on attempt ${attempt}:`, error.message);
          throw error;
        }
      }
    }

    // FIXED: getUnmatchedSMS method
    static async getUnmatchedSMS() {
        try {
            console.log('🔍 Getting unmatched SMS...');
            
            // Query by smsType field, not metadata.smsType
            const unmatchedSMS = await SMSDeposit.find({ 
                status: 'RECEIVED_WAITING_MATCH',
                smsType: { $in: ['SENDER', 'RECEIVER'] }
            })
            .populate('userId', 'firstName username telegramId')
            .sort({ createdAt: -1 })
            .limit(50);
            
            console.log(`📊 Found ${unmatchedSMS.length} unmatched SMS`);
            
            // Group by type
            const grouped = {
                SENDER: unmatchedSMS.filter(sms => sms.smsType === 'SENDER'),
                RECEIVER: unmatchedSMS.filter(sms => sms.smsType === 'RECEIVER')
            };
            
            console.log(`📤 Sender SMS: ${grouped.SENDER.length}, 📥 Receiver SMS: ${grouped.RECEIVER.length}`);
            
            return grouped;
        } catch (error) {
            console.error('❌ Error getting unmatched SMS:', error);
            throw error;
        }
    }

      // NEW: Manual match for admin
      static async manualMatchSMS(senderSMSId, receiverSMSId, adminUserId) {
        const session = await mongoose.startSession();
        session.startTransaction();

        try {
          console.log('🔄 Admin manually matching SMS...');
          
          const [senderSMS, receiverSMS] = await Promise.all([
            SMSDeposit.findById(senderSMSId).populate('userId'),
            SMSDeposit.findById(receiverSMSId)
          ]);
          
          if (!senderSMS || !receiverSMS) {
            throw new Error('One or both SMS deposits not found');
          }
          
          if (senderSMS.metadata?.smsType !== 'SENDER') {
            throw new Error('First SMS must be a SENDER type');
          }
          
          if (receiverSMS.metadata?.smsType !== 'RECEIVER') {
            throw new Error('Second SMS must be a RECEIVER type');
          }
          
          // Use the same approve logic
          const result = await this.approveMatchedSMS(senderSMS, receiverSMS);
          
          // Update with admin info
          senderSMS.processedBy = adminUserId;
          senderSMS.metadata.manuallyApprovedBy = adminUserId;
          await senderSMS.save({ session });
          
          await session.commitTransaction();
          
          return {
            ...result,
            manuallyApproved: true,
            approvedBy: adminUserId
          };
          
        } catch (error) {
          await session.abortTransaction();
          console.error('❌ Error in manual match:', error);
          throw error;
        } finally {
          session.endSession();
        }
      }

    // NEW: Parse SMS time string to Date
    static parseSMSTime(timeString) {
      try {
        // Handle format: "07/12/2025 at 21:58:15"
        const cleaned = timeString.replace(' at ', ' ');
        return new Date(cleaned);
      } catch (error) {
        console.error('Error parsing time:', timeString, error);
        return null;
      }
    }

    // NEW: Check if names are similar (allowing for small differences)
    static namesAreSimilar(name1, name2) {
      if (!name1 || !name2) return false;
      
      const clean1 = name1.toLowerCase().replace(/\s+/g, ' ').trim();
      const clean2 = name2.toLowerCase().replace(/\s+/g, ' ').trim();
      
      // Exact match
      if (clean1 === clean2) return true;
      
      // Check if one contains the other
      if (clean1.includes(clean2) || clean2.includes(clean1)) {
        return true;
      }
      
      // Check first name match (split by space)
      const name1Parts = clean1.split(' ');
      const name2Parts = clean2.split(' ');
      
      if (name1Parts[0] === name2Parts[0]) {
        return true; // Same first name
      }
      
      // Calculate similarity using simple algorithm
      let matches = 0;
      for (const word1 of name1Parts) {
        for (const word2 of name2Parts) {
          if (word1 === word2 || word1.includes(word2) || word2.includes(word1)) {
            matches++;
            break;
          }
        }
      }
      
      const similarity = matches / Math.max(name1Parts.length, name2Parts.length);
      return similarity >= 0.5; // 50% similarity
    }

    // NEW: Auto-approve matched SMS
    static async autoApproveMatchedSMS(senderSMS, receiverSMS) {
      const session = await mongoose.startSession();
      session.startTransaction();

      try {
        console.log('🤖 Auto-approving matched SMS pair...');
        
        // Determine which is sender (user) and which is receiver (admin)
        let userSMS, adminSMS;
        if (senderSMS.metadata?.smsType === 'SENDER') {
          userSMS = senderSMS;
          adminSMS = receiverSMS;
        } else {
          userSMS = receiverSMS;
          adminSMS = senderSMS;
        }
        
        // Get user from user SMS
        const user = await User.findById(userSMS.userId);
        if (!user) {
          throw new Error('User not found for matched SMS');
        }
        
        const amount = userSMS.extractedAmount;
        
        // Get or create wallet
        let wallet = await Wallet.findOne({ userId: user._id }).session(session);
        if (!wallet) {
          wallet = new Wallet({
            userId: user._id,
            balance: 0,
            currency: 'USD'
          });
        }
        
        const balanceBefore = wallet.balance;
        wallet.balance += amount;
        const balanceAfter = wallet.balance;
        
        // Create transaction
        const transaction = new Transaction({
          userId: user._id,
          type: 'DEPOSIT',
          amount,
          balanceBefore,
          balanceAfter,
          status: 'COMPLETED',
          description: `Auto-approved deposit via ${userSMS.paymentMethod} (SMS matched)`,
          reference: `SMS-MATCHED-${Date.now()}`,
          metadata: {
            paymentMethod: userSMS.paymentMethod,
            autoMatched: true,
            matchedPair: {
              senderSMSId: userSMS._id,
              receiverSMSId: adminSMS._id,
              matchConfidence: this.calculateSMSMatchScore(
                this.extractTransactionIdentifiers(userSMS.originalSMS),
                this.extractTransactionIdentifiers(adminSMS.originalSMS)
              ),
              matchedAt: new Date()
            }
          }
        });
        
        // Update both SMS deposits
        userSMS.status = 'AUTO_APPROVED';
        userSMS.transactionId = transaction._id;
        userSMS.autoApproved = true;
        userSMS.processedAt = new Date();
        userSMS.metadata.matched = true;
        userSMS.metadata.matchedWith = adminSMS._id;
        
        adminSMS.status = 'CONFIRMED';
        adminSMS.metadata.matched = true;
        adminSMS.metadata.matchedWith = userSMS._id;
        adminSMS.metadata.confirmedAmount = amount;
        
        await transaction.save({ session });
        await wallet.save({ session });
        await userSMS.save({ session });
        await adminSMS.save({ session });
        await session.commitTransaction();
        
        console.log(`✅ Auto-approved matched deposit: $${amount} for user ${user.telegramId}`);
        
        return {
          transaction,
          wallet,
          userSMS,
          adminSMS,
          autoApproved: true
        };
        
      } catch (error) {
        await session.abortTransaction();
        console.error('❌ Error auto-approving matched SMS:', error);
        throw error;
      } finally {
        session.endSession();
      }
    }

    // NEW: Admin command to force match SMS
    static async adminForceMatchSMS(senderSMSId, receiverSMSId, adminUserId) {
      const session = await mongoose.startSession();
      session.startTransaction();

      try {
        console.log('🔄 Admin forcing SMS match...');
        
        const [senderSMS, receiverSMS] = await Promise.all([
          SMSDeposit.findById(senderSMSId).populate('userId'),
          SMSDeposit.findById(receiverSMSId).populate('userId')
        ]);
        
        if (!senderSMS || !receiverSMS) {
          throw new Error('One or both SMS deposits not found');
        }
        
        const user = senderSMS.userId;
        const amount = senderSMS.extractedAmount;
        
        // Get or create wallet
        let wallet = await Wallet.findOne({ userId: user._id }).session(session);
        if (!wallet) {
          wallet = new Wallet({
            userId: user._id,
            balance: 0,
            currency: 'USD'
          });
        }
        
        const balanceBefore = wallet.balance;
        wallet.balance += amount;
        const balanceAfter = wallet.balance;
        
        // Create transaction
        const transaction = new Transaction({
          userId: user._id,
          type: 'DEPOSIT',
          amount,
          balanceBefore,
          balanceAfter,
          status: 'COMPLETED',
          description: `Admin-approved deposit via ${senderSMS.paymentMethod}`,
          reference: `SMS-ADMIN-${Date.now()}`,
          metadata: {
            paymentMethod: senderSMS.paymentMethod,
            adminApproved: true,
            approvedBy: adminUserId,
            approvedAt: new Date(),
            matchedByAdmin: true,
            matchedPair: {
              senderSMSId: senderSMS._id,
              receiverSMSId: receiverSMS._id
            }
          }
        });
        
        // Update SMS deposits
        senderSMS.status = 'APPROVED';
        senderSMS.transactionId = transaction._id;
        senderSMS.processedBy = adminUserId;
        senderSMS.processedAt = new Date();
        senderSMS.metadata.adminMatched = true;
        senderSMS.metadata.matchedWith = receiverSMS._id;
        
        receiverSMS.status = 'CONFIRMED';
        receiverSMS.metadata.adminMatched = true;
        receiverSMS.metadata.matchedWith = senderSMS._id;
        receiverSMS.metadata.confirmedAmount = amount;
        
        await transaction.save({ session });
        await wallet.save({ session });
        await senderSMS.save({ session });
        await receiverSMS.save({ session });
        await session.commitTransaction();
        
        console.log(`✅ Admin matched and approved deposit: $${amount} for user ${user.telegramId}`);
        
        return {
          transaction,
          wallet,
          senderSMS,
          receiverSMS,
          adminApproved: true
        };
        
      } catch (error) {
        await session.abortTransaction();
        console.error('❌ Error in admin force match:', error);
        throw error;
      } finally {
        session.endSession();
      }
    }

    // NEW: Find matching SMS for admin
    static async findMatchingSMS(smsDepositId) {
        try {
          const smsDeposit = await SMSDeposit.findById(smsDepositId);
          if (!smsDeposit) {
            throw new Error('SMS deposit not found');
          }
          
          const smsText = smsDeposit.originalSMS;
          const analysis = this.analyzeSMSType(smsText);
          const identifiers = this.extractTransactionIdentifiers(smsText);
          
          const oppositeType = analysis.type === 'SENDER' ? 'RECEIVER' : 'SENDER';
          
          // Build query using stored references
          const query = {
            _id: { $ne: smsDepositId },
            status: { $in: ['RECEIVED', 'RECEIVED_WAITING_MATCH', 'PENDING'] },
            smsType: oppositeType,
            extractedAmount: smsDeposit.extractedAmount,
            createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
          };
          
          // If we have a reference, use it for matching
          if (smsDeposit.extractedReference) {
            query.$or = [
              { extractedReference: smsDeposit.extractedReference },
              { 'metadata.refNumber': smsDeposit.extractedReference }
            ];
          }
          
          const potentialMatches = await SMSDeposit.find(query)
            .populate('userId', 'firstName username telegramId')
            .sort({ createdAt: -1 })
            .limit(50);
          
          // Calculate match scores
          const matchesWithScores = potentialMatches.map(match => {
            const matchIdentifiers = this.extractTransactionIdentifiers(match.originalSMS);
            const score = this.calculateSMSMatchScore(identifiers, match);
            
            return {
              smsDeposit: match,
              score: Math.round(score * 100), // Percentage
              amount: match.extractedAmount,
              reference: match.extractedReference,
              time: match.createdAt,
              identifiers: matchIdentifiers
            };
          });
          
          // Sort by score descending
          matchesWithScores.sort((a, b) => b.score - a.score);
          
          return {
            originalSMS: smsDeposit,
            analysis,
            identifiers,
            matches: matchesWithScores.filter(m => m.score >= 50), // Only show 50%+ matches
            totalFound: potentialMatches.length
          };
          
        } catch (error) {
          console.error('❌ Error finding matching SMS:', error);
          throw error;
        }
      }
      // NEW: Auto-process received SMS immediately
    static async autoProcessReceivedSMS() {
        try {
          const receivedSMS = await SMSDeposit.find({ 
            status: 'RECEIVED_WAITING_MATCH',
            extractedReference: { $exists: true, $ne: null }
          })
          .populate('userId', 'firstName username telegramId')
          .sort({ createdAt: 1 })
          .limit(100); // Increased limit for better matching

          console.log(`🔄 Found ${receivedSMS.length} SMS with references waiting for match`);

          let matchedCount = 0;
          let processingErrors = 0;

          // Group by reference for more efficient matching
          const smsByReference = {};
          receivedSMS.forEach(sms => {
            if (sms.extractedReference) {
              if (!smsByReference[sms.extractedReference]) {
                smsByReference[sms.extractedReference] = [];
              }
              smsByReference[sms.extractedReference].push(sms);
            }
          });

          // Process each reference group
          for (const [reference, smsList] of Object.entries(smsByReference)) {
            if (smsList.length >= 2) {
              console.log(`🔍 Processing reference ${reference} with ${smsList.length} SMS`);
              
              // Find SENDER and RECEIVER SMS
              const senders = smsList.filter(s => s.smsType === 'SENDER');
              const receivers = smsList.filter(s => s.smsType === 'RECEIVER');
              
              if (senders.length > 0 && receivers.length > 0) {
                // Try to match first sender with first receiver
                try {
                  const result = await this.approveMatchedSMS(senders[0], receivers[0]);
                  if (result) {
                    matchedCount++;
                    console.log(`✅ Matched reference ${reference}: ${senders[0]._id} with ${receivers[0]._id}`);
                  }
                } catch (error) {
                  console.error(`❌ Error matching reference ${reference}:`, error.message);
                  processingErrors++;
                }
              }
            }
          }

          return { 
            total: receivedSMS.length, 
            matched: matchedCount,
            errors: processingErrors,
            referenceGroups: Object.keys(smsByReference).length
          };
        } catch (error) {
          console.error('❌ Error in auto-process SMS:', error);
          throw error;
        }
      }


      // ENHANCED: Analyze SMS type for CBE format
      static analyzeSMSType(smsText) {
        const sms = smsText.toLowerCase();
        
        // Sender SMS patterns (user sent money to admin)
        const senderPatterns = [
          /you have transfered.*etb.*to/i,
          /your account has been debited/i,
          /sent.*etb.*to/i,
          /transfer.*to.*account/i,
          /you have sent.*birr.*to/i,
          /you have transfered etb.*to.*on.*from your account/i, // CBE specific
          /your account has been debited with a s.charge/i // CBE specific
        ];
        
        // Receiver SMS patterns (admin received money from user)
        const receiverPatterns = [
          /your account.*has been credited/i,
          /received.*etb.*from/i,
          /credited with.*etb.*from/i,
          /account.*credited.*with/i,
          /you have received.*birr.*from/i,
          /your account.*has been credited with etb.*from/i // CBE specific
        ];
        
        // Check for sender patterns
        for (const pattern of senderPatterns) {
          if (pattern.test(sms)) {
            return { type: 'SENDER', confidence: 0.9 };
          }
        }
        
        // Check for receiver patterns
        for (const pattern of receiverPatterns) {
          if (pattern.test(sms)) {
            return { type: 'RECEIVER', confidence: 0.9 };
          }
        }
        
        return { type: 'UNKNOWN', confidence: 0.5 };
      }

      // ENHANCED: Extract transaction identifiers from CBE SMS
 // ENHANCED: Extract transaction identifiers from SMS (ALL BANKS SUPPORT)
static extractTransactionIdentifiers(smsText) {
    smsText = smsText.trim();
    
    console.log('🔍 EXTRACTING IDENTIFIERS (ENHANCED AMHARIC/ENGLISH SUPPORT)');
    console.log('📋 SMS LENGTH:', smsText.length);
    console.log('📄 SMS CONTENT:', smsText.substring(0, 200) + '...');
    
    const identifiers = {
        amount: null,
        exactAmount: null,
        transactionId: null,
        refNumber: null,
        cleanRefNumber: null,
        rawRefNumber: null,
        time: null,
        senderName: null,
        recipientName: null,
        senderPhone: null,
        recipientPhone: null,
        accountNumbers: [],
        smsBank: this.detectBankFromSMS(smsText),
        paymentMethod: null,
        isCredit: false,
        isDebit: false,
        direction: null,
        newBalance: null,
        rawSMS: smsText,
        extractionMethod: 'ENHANCED_AMHARIC',
        confidence: 0
    };
    
    const sms = smsText.toLowerCase();
    
    // ========== BANK DETECTION ==========
    console.log('🏦 Detected bank:', identifiers.smsBank);
    
    // ========== TRANSACTION TYPE DETECTION ==========
    // Enhanced detection for Amharic and English
    const creditPatterns = [
        /ተቀብለዋል|ተቀብሏል|received|credited/i,
        /you have received|ከ.*ተቀብለዋል/i,
        /dear.*received|ውድ.*ተቀብለዋል/i
    ];
    
    const debitPatterns = [
        /የላኩ|sent|transfered|transferred|debited/i,
        /you have (?:sent|transfered|transferred)/i
    ];
    
    identifiers.isCredit = creditPatterns.some(pattern => pattern.test(smsText));
    identifiers.isDebit = debitPatterns.some(pattern => pattern.test(smsText));
    
    if (identifiers.isCredit) identifiers.direction = 'INCOMING';
    if (identifiers.isDebit) identifiers.direction = 'OUTGOING';
    
    console.log('💳 Transaction type:', {
        isCredit: identifiers.isCredit,
        isDebit: identifiers.isDebit,
        direction: identifiers.direction
    });
    
    // ========== TELEBIRR SPECIFIC EXTRACTION (BOTH LANGUAGES) ==========
    if (identifiers.smsBank === 'Telebirr' || sms.includes('በቴሌብር') || sms.includes('ethio telecom')) {
        console.log('📱 Processing Telebirr SMS (Amharic/English)...');
        identifiers.smsBank = 'Telebirr';
        identifiers.paymentMethod = 'Telebirr';
        
        // For Amharic SMS: "ውድ Degafi ከ DEFAR GOBEZE(2519****8285) 20.00 ብር ተቀብለዋል"
        // For English SMS: "Dear DEFAR, You have received ETB 2,000.00"
        
        // ========== AMOUNT EXTRACTION ==========
        // Amharic pattern: 20.00 ብር
        const amharicAmountPattern = /(\d+[.,]?\d*)\s*ብር/i;
        const amharicAmountMatch = smsText.match(amharicAmountPattern);
        
        // English pattern: ETB 2,000.00
        const englishAmountPattern = /ETB\s*([\d,]+\.?\d*)/i;
        const englishAmountMatch = smsText.match(englishAmountPattern);
        
        // Generic patterns
        const genericPatterns = [
            /(\d+[.,]?\d*)\s*(?:ETB|birr|br|ብር)/i,
            /(?:ETB|birr|br|ብር)\s*(\d+[.,]?\d*)/i,
            /received.*?(\d+[.,]?\d*)/i,
            /ተቀብለዋል.*?(\d+[.,]?\d*)/i
        ];
        
        // Try Amharic first
        if (amharicAmountMatch && amharicAmountMatch[1]) {
            const cleanAmount = amharicAmountMatch[1].replace(/,/g, '');
            identifiers.exactAmount = parseFloat(cleanAmount);
            identifiers.amount = identifiers.exactAmount;
            console.log('💰 Amharic amount extracted:', identifiers.amount);
        }
        // Try English
        else if (englishAmountMatch && englishAmountMatch[1]) {
            const cleanAmount = englishAmountMatch[1].replace(/,/g, '');
            identifiers.exactAmount = parseFloat(cleanAmount);
            identifiers.amount = identifiers.exactAmount;
            console.log('💰 English amount extracted:', identifiers.amount);
        }
        // Try generic patterns
        else {
            for (const pattern of genericPatterns) {
                const match = smsText.match(pattern);
                if (match && match[1]) {
                    const cleanAmount = match[1].replace(/,/g, '');
                    identifiers.exactAmount = parseFloat(cleanAmount);
                    identifiers.amount = identifiers.exactAmount;
                    console.log('💰 Generic amount extracted:', identifiers.amount, 'Pattern:', pattern);
                    break;
                }
            }
        }
        
        // ========== TRANSACTION ID EXTRACTION ==========
        // Amharic: "የሂሳብ እንቅስቃሴ ቁጥርዎ DB22EKVKKW"
        const amharicTxnPattern = /የሂሳብ.*?ቁጥርዎ\s*([A-Z0-9]{8,12})/i;
        const amharicTxnMatch = smsText.match(amharicTxnPattern);
        
        // English: "transaction number CKQ9GCUTF7"
        const englishTxnPattern = /transaction.*?(?:number|id).*?([A-Z0-9]{8,12})/i;
        const englishTxnMatch = smsText.match(englishTxnPattern);
        
        // Common patterns
        const txnPatterns = [
            /(?:txn|transaction).*?([A-Z0-9]{8,12})/i,
            /([A-Z0-9]{8,12})/,
            /DB[A-Z0-9]{8,}/i, // DB22EKVKKW pattern
            /CK[A-Z0-9]{8,}/i  // CKQ9GCUTF7 pattern
        ];
        
        if (amharicTxnMatch && amharicTxnMatch[1]) {
            identifiers.transactionId = amharicTxnMatch[1].toUpperCase();
            identifiers.refNumber = identifiers.transactionId;
            identifiers.cleanRefNumber = identifiers.transactionId;
            console.log('✅ Amharic transaction ID found:', identifiers.transactionId);
        } else if (englishTxnMatch && englishTxnMatch[1]) {
            identifiers.transactionId = englishTxnMatch[1].toUpperCase();
            identifiers.refNumber = identifiers.transactionId;
            identifiers.cleanRefNumber = identifiers.transactionId;
            console.log('✅ English transaction ID found:', identifiers.transactionId);
        } else {
            for (const pattern of txnPatterns) {
                const match = smsText.match(pattern);
                if (match && match[1]) {
                    const txnId = match[1].toUpperCase();
                    // Skip if it looks like a phone number or small number
                    if (!/^\d{10,12}$/.test(txnId) && txnId.length >= 8) {
                        identifiers.transactionId = txnId;
                        identifiers.refNumber = identifiers.transactionId;
                        identifiers.cleanRefNumber = identifiers.transactionId;
                        console.log('✅ Transaction ID found via pattern:', identifiers.transactionId);
                        break;
                    }
                }
            }
        }
        
        // ========== NAMES EXTRACTION ==========
        // Amharic: "ውድ Degafi ከ DEFAR GOBEZE"
        const amharicNamePattern = /ውድ\s+([A-Za-z\s]+?)\s+ከ\s+([A-Za-z\s]+?)\(/i;
        const amharicNameMatch = smsText.match(amharicNamePattern);
        
        // English: "Dear DEFAR, You have received ... from Commercial Bank of Ethiopia"
        const englishNamePattern = /dear\s+([A-Za-z\s]+?),/i;
        const englishNameMatch = smsText.match(englishNamePattern);
        
        if (amharicNameMatch) {
            // Amharic: recipient first, then sender
            identifiers.recipientName = amharicNameMatch[1].trim();
            identifiers.senderName = amharicNameMatch[2].trim();
            console.log('👤 Amharic names - Recipient:', identifiers.recipientName, 'Sender:', identifiers.senderName);
        } else if (englishNameMatch) {
            // English: "Dear [recipient]"
            identifiers.recipientName = englishNameMatch[1].trim();
            console.log('👤 English recipient name:', identifiers.recipientName);
            
            // Try to extract sender from English SMS
            const fromPattern = /from\s+([A-Za-z\s]+?)\s*(?:to|your|account|,|$)/i;
            const fromMatch = smsText.match(fromPattern);
            if (fromMatch) {
                identifiers.senderName = fromMatch[1].trim();
                console.log('👤 English sender name:', identifiers.senderName);
            }
        }
        
        // ========== PHONE NUMBERS EXTRACTION ==========
        // Amharic: "(2519****8285)"
        const amharicPhonePattern = /\((\d{4}\*\*\*\*\d{4})\)/;
        const amharicPhoneMatch = smsText.match(amharicPhonePattern);
        
        // English: "251974108285"
        const englishPhonePattern = /(\+?2519\d{8})/;
        const englishPhoneMatch = smsText.match(englishPhonePattern);
        
        if (amharicPhoneMatch && amharicPhoneMatch[1]) {
            // Format: 2519****8285 -> reconstruct to 2519xxxxxxxx
            const maskedPhone = amharicPhoneMatch[1];
            const prefix = maskedPhone.substring(0, 4); // "2519"
            const suffix = maskedPhone.substring(8);    // "8285"
            identifiers.senderPhone = prefix + 'xxxx' + suffix;
            console.log('📱 Amharic masked phone:', maskedPhone, '->', identifiers.senderPhone);
        } else if (englishPhoneMatch && englishPhoneMatch[1]) {
            identifiers.senderPhone = englishPhoneMatch[1];
            console.log('📱 English phone number:', identifiers.senderPhone);
        }
        
        // ========== TIME EXTRACTION ==========
        // Amharic: "በ 02/02/2026 11:11:50"
        const amharicTimePattern = /በ\s*(\d{2}\/\d{2}\/\d{4})\s+(\d{2}:\d{2}:\d{2})/i;
        const amharicTimeMatch = smsText.match(amharicTimePattern);
        
        // English: "on 2025-11-26 19:37:25"
        const englishTimePattern = /on\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/i;
        const englishTimeMatch = smsText.match(englishTimePattern);
        
        // Generic time patterns
        const timePatterns = [
            /(\d{2}\/\d{2}\/\d{4})\s+(\d{2}:\d{2}:\d{2})/,
            /(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/,
            /(\d{2}:\d{2}:\d{2})/
        ];
        
        if (amharicTimeMatch && amharicTimeMatch[1] && amharicTimeMatch[2]) {
            identifiers.time = `${amharicTimeMatch[1]} ${amharicTimeMatch[2]}`;
            console.log('⏰ Amharic time extracted:', identifiers.time);
        } else if (englishTimeMatch && englishTimeMatch[1] && englishTimeMatch[2]) {
            identifiers.time = `${englishTimeMatch[1]} ${englishTimeMatch[2]}`;
            console.log('⏰ English time extracted:', identifiers.time);
        } else {
            for (const pattern of timePatterns) {
                const match = smsText.match(pattern);
                if (match) {
                    if (match[1] && match[2]) {
                        identifiers.time = `${match[1]} ${match[2]}`;
                    } else if (match[1]) {
                        identifiers.time = match[1];
                    }
                    console.log('⏰ Time extracted via pattern:', identifiers.time);
                    break;
                }
            }
        }
        
        // ========== BALANCE EXTRACTION ==========
        // Amharic: "ቀሪ ሂሳብ 317.00 ብር"
        const amharicBalancePattern = /ቀሪ.*?ሂሳብ\s*(\d+[.,]?\d*)\s*ብር/i;
        const amharicBalanceMatch = smsText.match(amharicBalancePattern);
        
        // English: "Your current balance is ETB 2,980.87"
        const englishBalancePattern = /balance.*?ETB\s*([\d,]+\.?\d*)/i;
        const englishBalanceMatch = smsText.match(englishBalancePattern);
        
        if (amharicBalanceMatch && amharicBalanceMatch[1]) {
            const cleanBalance = amharicBalanceMatch[1].replace(/,/g, '');
            identifiers.newBalance = parseFloat(cleanBalance);
            console.log('💎 Amharic balance extracted:', identifiers.newBalance);
        } else if (englishBalanceMatch && englishBalanceMatch[1]) {
            const cleanBalance = englishBalanceMatch[1].replace(/,/g, '');
            identifiers.newBalance = parseFloat(cleanBalance);
            console.log('💎 English balance extracted:', identifiers.newBalance);
        }
        
        // ========== SMS TYPE DETECTION FOR TELEBIRR ==========
        // For Telebirr, we need to determine if this is a SENDER or RECEIVER SMS
        // Amharic: "ተቀብለዋል" means "received" (RECEIVER)
        // English: "You have received" means RECEIVER
        
        if (sms.includes('ተቀብለዋል') || sms.includes('received')) {
            identifiers.isCredit = true;
            identifiers.direction = 'INCOMING';
            console.log('📥 Telebirr SMS type: RECEIVER (money received)');
        } else if (sms.includes('የላኩ') || sms.includes('sent')) {
            identifiers.isDebit = true;
            identifiers.direction = 'OUTGOING';
            console.log('📤 Telebirr SMS type: SENDER (money sent)');
        }
    }
    
    // ========== CBE AND OTHER BANKS ==========
      // ========== CBE SPECIFIC EXTRACTION ==========
    else if (identifiers.smsBank === 'CBE') {
        console.log('🏦 Processing CBE SMS...');
        identifiers.smsBank = 'CBE';
        identifiers.paymentMethod = 'CBE Bank';
        
        // CBE URL reference extraction (most reliable)
        const urlPattern = /(?:https?:\/\/apps\.cbe\.com\.et(?::\d+)?\/\?id=|id=)([A-Z0-9]+)/i;
        const urlMatch = smsText.match(urlPattern);
        
        if (urlMatch && urlMatch[1]) {
            const fullId = urlMatch[1].toUpperCase();
            identifiers.rawRefNumber = fullId;
            console.log('🔗 Found CBE URL reference:', fullId);
            
            // CBE pattern: FT26026HKU6411206342 (20 chars)
            // Extract base reference (first 12 chars)
            if (fullId.length >= 20) {
                identifiers.refNumber = fullId.substring(0, 12); // FT26026HKU64
                identifiers.cleanRefNumber = identifiers.refNumber;
                console.log('✅ Extracted CBE base reference:', identifiers.refNumber);
                console.log('📝 Full reference with suffix:', identifiers.rawRefNumber);
            } else {
                identifiers.refNumber = fullId;
                identifiers.cleanRefNumber = this.cleanCBEReference(fullId);
                console.log('✅ Using full URL reference:', identifiers.refNumber);
            }
        }
        
        // CBE "Ref No" pattern
        if (!identifiers.refNumber) {
            const refPattern = /Ref\s*No\s*([A-Z0-9]+)/i;
            const refMatch = smsText.match(refPattern);
            if (refMatch && refMatch[1]) {
                identifiers.refNumber = refMatch[1].toUpperCase();
                identifiers.cleanRefNumber = this.cleanCBEReference(identifiers.refNumber);
                console.log('✅ Found CBE Ref No:', identifiers.refNumber);
            }
        }
        
        // CBE FT pattern anywhere
        if (!identifiers.refNumber) {
            const ftPattern = smsText.match(/(FT\d+[A-Z]+)/i);
            if (ftPattern && ftPattern[1]) {
                identifiers.refNumber = ftPattern[1].toUpperCase();
                identifiers.cleanRefNumber = this.cleanCBEReference(identifiers.refNumber);
                console.log('✅ Found FT pattern:', identifiers.refNumber);
            }
        }
        
        // Name extraction for CBE
        if (identifiers.direction === 'INCOMING') {
            // Sender: "from Defar Gobeze"
            const fromMatch = smsText.match(/from\s+([A-Za-z\s]+?)\s*(?:,|\.|on|with|Your)/i);
            if (fromMatch) {
                identifiers.senderName = fromMatch[1].trim();
                console.log('👤 Sender name (CBE):', identifiers.senderName);
            }
        } else {
            // Recipient: "to Defar Gobeze"
            const toMatch = smsText.match(/to\s+([A-Za-z\s]+?)\s*(?:,|\.|on|with|from)/i);
            if (toMatch) {
                identifiers.recipientName = toMatch[1].trim();
                console.log('👤 Recipient name (CBE):', identifiers.recipientName);
            }
        }
        
        // Account number extraction (masked)
        const accountMatches = smsText.match(/(\d[\*]+\d+)/g);
        if (accountMatches) {
            identifiers.accountNumbers = accountMatches;
            console.log('🏦 Account numbers found:', accountMatches);
        }
    }
    
    // ========== OTHER BANKS (Awash, Dashen, BOA) ==========
    else {
        console.log('🏛️ Processing other bank SMS...');
        
        // Try to extract reference from common patterns
        const commonRefPatterns = [
            /Ref\s*(?:No|Number)?[:\s]*([A-Z0-9]+)/i,
            /Transaction\s*(?:ID|No)?[:\s]*([A-Z0-9]+)/i,
            /Txn\s*(?:ID|No)?[:\s]*([A-Z0-9]+)/i,
            /([A-Z0-9]{8,15})/ // Any alphanumeric sequence
        ];
        
        for (const pattern of commonRefPatterns) {
            const match = smsText.match(pattern);
            if (match && match[1]) {
                const ref = match[1].toUpperCase();
                // Skip if it looks like an amount or phone number
                if (!/^\d+\.?\d*$/.test(ref) && !/^\d{9,12}$/.test(ref)) {
                    identifiers.refNumber = ref;
                    identifiers.cleanRefNumber = ref;
                    console.log('✅ Reference extracted:', identifiers.refNumber);
                    break;
                }
            }
        }
        
        // Name extraction for other banks
        if (identifiers.direction === 'INCOMING') {
            const fromMatch = smsText.match(/from\s+([A-Za-z\s]+?)\s*(?:,|\.|$)/i);
            if (fromMatch) {
                identifiers.senderName = fromMatch[1].trim();
                console.log('👤 Sender name:', identifiers.senderName);
            }
        } else {
            const toMatch = smsText.match(/to\s+([A-Za-z\s]+?)\s*(?:,|\.|$)/i);
            if (toMatch) {
                identifiers.recipientName = toMatch[1].trim();
                console.log('👤 Recipient name:', identifiers.recipientName);
            }
        }
    }
    
    // ========== FINAL CLEANUP ==========
    
    // If no clean reference but have refNumber, clean it
    if (!identifiers.cleanRefNumber && identifiers.refNumber) {
        if (identifiers.smsBank === 'CBE') {
            identifiers.cleanRefNumber = this.cleanCBEReference(identifiers.refNumber);
        } else {
            identifiers.cleanRefNumber = identifiers.refNumber;
        }
    }
    
    // Set payment method if not set
    if (!identifiers.paymentMethod) {
        identifiers.paymentMethod = this.detectPaymentMethodFromSMS(smsText);
    }
    
    // Calculate confidence score
    identifiers.confidence = this.calculateExtractionConfidence(identifiers);
    
    console.log('✅ FINAL EXTRACTED IDENTIFIERS:', {
        bank: identifiers.smsBank,
        paymentMethod: identifiers.paymentMethod,
        amount: identifiers.exactAmount || identifiers.amount,
        reference: identifiers.cleanRefNumber || identifiers.refNumber,
        transactionId: identifiers.transactionId,
        direction: identifiers.direction,
        senderName: identifiers.senderName,
        recipientName: identifiers.recipientName,
        time: identifiers.time,
        confidence: identifiers.confidence
    });
    
    return identifiers;
}

// HELPER: Calculate extraction confidence
static calculateExtractionConfidence(identifiers) {
    let score = 0;
    const maxScore = 100;
    
    // Amount extracted (30 points)
    if (identifiers.exactAmount) score += 30;
    else if (identifiers.amount) score += 20;
    
    // Reference extracted (25 points)
    if (identifiers.cleanRefNumber) score += 25;
    else if (identifiers.refNumber) score += 15;
    
    // Transaction type identified (15 points)
    if (identifiers.isCredit || identifiers.isDebit) score += 15;
    
    // Bank identified (10 points)
    if (identifiers.smsBank !== 'UNKNOWN') score += 10;
    
    // Time extracted (10 points)
    if (identifiers.time) score += 10;
    
    // Names extracted (10 points)
    if (identifiers.senderName || identifiers.recipientName) score += 10;
    
    const percentage = (score / maxScore) * 100;
    console.log(`📊 Extraction confidence: ${percentage.toFixed(1)}% (${score}/${maxScore})`);
    
    return percentage / 100;
}

// HELPER: Clean CBE reference
static cleanCBEReference(reference) {
    if (!reference) return null;
    
    const ref = reference.toUpperCase();
    console.log('🧹 Cleaning reference:', ref);
    
    // CBE FT reference cleanup
    if (ref.startsWith('FT')) {
        // Remove 8-digit account suffix if present
        if (ref.length >= 20) {
            const last8 = ref.slice(-8);
            if (/^\d{8}$/.test(last8)) {
                const cleanRef = ref.slice(0, -8);
                console.log(`✅ Removed account suffix: ${ref} -> ${cleanRef}`);
                return cleanRef;
            }
        }
        // If reference is exactly 12 chars (FT26026HKU64), keep as is
        if (ref.length === 12 && /^FT\d{5}[A-Z0-9]{5}$/.test(ref)) {
            console.log(`✅ Valid CBE reference: ${ref}`);
            return ref;
        }
    }
    
    // Telebirr references (alphanumeric, 8-12 chars)
    if (/^[A-Z0-9]{8,12}$/.test(ref) && !ref.startsWith('FT')) {
        console.log(`📱 Telebirr reference: ${ref}`);
        return ref;
    }
    
    console.log(`✅ Reference (no change): ${ref}`);
    return ref;
}

// HELPER: Detect bank from SMS
static detectBankFromSMS(smsText) {
    const sms = smsText.toLowerCase();
    
    if (sms.includes('cbe') && !sms.includes('telebirr')) return 'CBE';
    if (sms.includes('awash') || sms.includes('abysinia')) return 'Awash';
    if (sms.includes('dashen')) return 'Dashen';
    if (sms.includes('telebirr') || sms.includes('ethio telecom') || sms.includes('ethiotelecom')) return 'Telebirr';
    if (sms.includes('ንብረት') || sms.includes('nib')) return 'NIB';
    if (sms.includes('ህብረት') || sms.includes('hibret')) return 'Hibret';
    
    return 'UNKNOWN';
}

// HELPER: Detect payment method from SMS
static detectPaymentMethodFromSMS(smsText) {
    const bank = this.detectBankFromSMS(smsText);
    const sms = smsText.toLowerCase();
    
    switch(bank) {
        case 'CBE':
            return sms.includes('birr') ? 'CBE Birr' : 'CBE Bank';
        case 'Awash':
            return 'Bank of Abysinia';
        case 'Dashen':
            return 'Dashen Bank';
        case 'Telebirr':
            return 'Telebirr';
        case 'NIB':
            return 'NIB Bank';
        case 'Hibret':
            return 'Hibret Bank';
        default:
            return 'UNKNOWN';
    }
}
      // NEW: Enhanced CBE amount extraction
      static extractAmountFromSMSCBE(smsText) {
        try {
          console.log('💰 Extracting CBE amount from SMS...');
          
          // CBE specific patterns
          const cbePatterns = [
            /ETB\s*([\d,]+\.?\d*)/i,  // ETB 400.00
            /ETB([\d,]+\.?\d*)/i,      // ETB400.00
            /([\d,]+\.?\d*)\s*ETB/i,  // 400.00 ETB
            /amount.*ETB\s*([\d,]+\.?\d*)/i,
            /credited with.*ETB\s*([\d,]+\.?\d*)/i,
            /transfered.*ETB\s*([\d,]+\.?\d*)/i
          ];
          
          let amount = null;
          
          for (const pattern of cbePatterns) {
            const match = smsText.match(pattern);
            if (match && match[1]) {
              const cleanAmount = match[1].replace(/,/g, '');
              amount = parseFloat(cleanAmount);
              console.log('✅ CBE amount extracted with pattern:', amount);
              if (amount > 0) break;
            }
          }
          
          // Fallback to generic extraction
          if (!amount || amount <= 0) {
            amount = this.extractAmountFromSMS(smsText);
          }
          
          return amount;
        } catch (error) {
          console.error('❌ Error extracting CBE amount:', error);
          return null;
        }
      }

      // NEW: Detect bank from SMS
    static detectBankFromSMS(smsText) {
      const sms = smsText.toLowerCase();
      if (sms.includes('cbe')) return 'CBE';
      if (sms.includes('awash')) return 'Awash';
      if (sms.includes('dashen')) return 'Dashen';
      if (sms.includes('telebirr') || sms.includes('ethio telecom') || sms.includes('ethiotelecom')) return 'Telebirr';
      return 'UNKNOWN';
    }

      // ENHANCED: Try to auto-match SMS with existing ones
    // FIXED: tryAutoMatchSMS without session parameter issues
    static async tryAutoMatchSMS(newSMSDeposit, smsText) {
      try {
        const newAnalysis = this.analyzeSMSType(smsText);
        const newIdentifiers = this.extractTransactionIdentifiers(smsText);
        
        console.log('🔍 Attempting to match SMS:', newSMSDeposit._id);
        console.log('📊 New SMS type:', newAnalysis.type);
        console.log('📊 New SMS amount:', newSMSDeposit.extractedAmount);
        console.log('📊 New SMS reference:', newSMSDeposit.extractedReference);
        
        if (!newSMSDeposit.extractedAmount || newSMSDeposit.extractedAmount <= 0) {
          console.log('⚠️ No valid amount, cannot match');
          return null;
        }
        
        // Find potential matches based on opposite type
        const oppositeType = newAnalysis.type === 'SENDER' ? 'RECEIVER' : 'SENDER';
        
        // Build query using stored fields
        const query = {
          _id: { $ne: newSMSDeposit._id },
          status: { 
            $in: ['RECEIVED', 'RECEIVED_WAITING_MATCH', 'PENDING'] 
          },
          smsType: oppositeType,
          extractedAmount: newSMSDeposit.extractedAmount,
          createdAt: { 
            $gte: new Date(Date.now() - 60 * 60 * 1000) // Last 1 hour
          }
        };
        
        // If we have a reference, use it for more precise matching
        if (newSMSDeposit.extractedReference) {
          query.$or = [
            { extractedReference: newSMSDeposit.extractedReference },
            { 'metadata.refNumber': newSMSDeposit.extractedReference },
            { 'metadata.rawRefNumber': newSMSDeposit.extractedReference }
          ];
          console.log('🔑 Using reference for matching:', newSMSDeposit.extractedReference);
        }
        
        console.log('🔍 Query for matches:', JSON.stringify(query, null, 2));
        
        const potentialMatches = await SMSDeposit.find(query)
          .populate('userId', 'firstName username telegramId')
          .sort({ createdAt: -1 })
          .limit(10);
        
        console.log(`🔍 Found ${potentialMatches.length} potential matches`);
        
        for (const potentialMatch of potentialMatches) {
          const matchScore = this.calculateSMSMatchScore(newIdentifiers, potentialMatch);
          console.log(`📊 Match score with ${potentialMatch._id}: ${matchScore}`);
          
          if (matchScore >= 0.85) { // 85% match confidence
            console.log(`✅ High confidence match found! (${matchScore})`);
            
            // APPROVE THE MATCHED TRANSACTION
            const result = await this.approveMatchedSMSWithRetry(newSMSDeposit, potentialMatch);
            return result;
          }
        }
        
        console.log('❌ No strong matches found');
        
        // If no match found, update status to waiting for match
        newSMSDeposit.status = 'RECEIVED_WAITING_MATCH';
        newSMSDeposit.smsType = newAnalysis.type;
        
        // Ensure reference is stored
        if (newIdentifiers.refNumber && !newSMSDeposit.extractedReference) {
          newSMSDeposit.extractedReference = newIdentifiers.refNumber;
        }
        
        newSMSDeposit.metadata.transactionIdentifiers = newIdentifiers;
        
        if (newAnalysis.type === 'SENDER') {
          newSMSDeposit.metadata.recipientName = newIdentifiers.recipientName;
        } else if (newAnalysis.type === 'RECEIVER') {
          newSMSDeposit.metadata.senderName = newIdentifiers.senderName;
        }
        
        await newSMSDeposit.save();
        return null;
        
      } catch (error) {
        console.error('❌ Error in auto-matching:', error);
        
        // Fallback: Save with basic status
        try {
          newSMSDeposit.status = 'RECEIVED';
          newSMSDeposit.metadata.matchingError = error.message;
          await newSMSDeposit.save();
        } catch (saveError) {
          console.error('❌ Could not save SMS deposit:', saveError);
        }
        
        return null;
      }
    }
// Add this method to your WalletService class
static async matchTelebirrSMS(smsDeposit, smsText) {
    try {
        console.log('📱 Processing Telebirr SMS for matching...');
        
        const analysis = this.analyzeSMSType(smsText);
        const identifiers = this.extractTransactionIdentifiers(smsText);
        
        console.log('📊 Telebirr Analysis:', {
            type: analysis.type,
            amount: smsDeposit.extractedAmount,
            transactionId: identifiers.transactionId,
            time: identifiers.time,
            direction: analysis.type === 'SENDER' ? 'USER_TO_ADMIN' : 'ADMIN_RECEIVED'
        });
        
        if (!smsDeposit.extractedAmount || smsDeposit.extractedAmount <= 0) {
            console.log('⚠️ No valid amount for Telebirr SMS');
            return null;
        }
        
        // CRITICAL: Check if this transaction already exists in ANY processed state
        const transactionId = identifiers.transactionId || smsDeposit.extractedReference;
        if (transactionId) {
            const existingProcessed = await SMSDeposit.findOne({
                $or: [
                    { extractedReference: transactionId },
                    { 'metadata.transactionId': transactionId }
                ],
                status: { $in: ['AUTO_APPROVED', 'APPROVED', 'CONFIRMED'] },
                _id: { $ne: smsDeposit._id } // Exclude current SMS
            });
            
            if (existingProcessed) {
                console.log(`❌ Transaction ${transactionId} already processed! Marking as duplicate.`);
                smsDeposit.status = 'DUPLICATE';
                smsDeposit.metadata.duplicateOf = existingProcessed._id;
                smsDeposit.metadata.duplicateReason = 'Same Telebirr transaction already processed';
                await smsDeposit.save();
                return null;
            }
        }
        
        // Determine opposite type
        const oppositeType = analysis.type === 'SENDER' ? 'RECEIVER' : 'SENDER';
        
        // Build query for Telebirr matching
        const query = {
            _id: { $ne: smsDeposit._id },
            status: { $in: ['RECEIVED', 'RECEIVED_WAITING_MATCH', 'PENDING'] },
            // FIX: Exclude already processed
            transactionId: { $exists: false },
            autoApproved: { $ne: true },
            'metadata.matched': { $ne: true },
            smsType: oppositeType,
            paymentMethod: { $regex: /Telebirr/i },
            extractedAmount: smsDeposit.extractedAmount,
            createdAt: { 
                $gte: new Date(Date.now() - 15 * 60 * 1000) // Last 15 minutes
            }
        };
        
        // Add transaction ID matching if available (most important for Telebirr)
        if (identifiers.transactionId) {
            query.$or = [
                { extractedReference: identifiers.transactionId },
                { 'metadata.transactionId': identifiers.transactionId },
                { 'metadata.rawRefNumber': identifiers.transactionId }
            ];
            console.log(`🔑 Telebirr transaction ID: ${identifiers.transactionId}`);
        }
        
        // Add phone number matching for Telebirr
        const phoneNumbers = this.extractPhoneNumbersFromSMS(smsText);
        if (phoneNumbers.length > 0 && analysis.type === 'RECEIVER') {
            // If admin received SMS, look for user SMS with same recipient phone
            query['metadata.recipientPhone'] = { $in: phoneNumbers };
        } else if (phoneNumbers.length > 0 && analysis.type === 'SENDER') {
            // If user sent SMS, look for admin SMS with same sender phone
            query['metadata.senderPhone'] = { $in: phoneNumbers };
        }
        
        console.log('🔍 Telebirr match query:', JSON.stringify(query, null, 2));
        
        const potentialMatches = await SMSDeposit.find(query)
            .populate('userId', 'firstName username telegramId')
            .sort({ createdAt: -1 })
            .limit(10);
        
        console.log(`🔍 Found ${potentialMatches.length} potential Telebirr matches`);
        
        // Calculate match scores and find best match
        let bestMatch = null;
        let bestScore = 0;
        
        for (const potentialMatch of potentialMatches) {
            // FIX: Additional check - see if this match is already paired
            if (potentialMatch.metadata?.matchedWith) {
                console.log(`⚠️ Skipping ${potentialMatch._id} - already matched with ${potentialMatch.metadata.matchedWith}`);
                continue;
            }
            
            const matchScore = this.calculateTelebirrMatchScore(identifiers, potentialMatch);
            console.log(`📊 Telebirr match score with ${potentialMatch._id}: ${matchScore}`);
            
            if (matchScore > bestScore && matchScore >= 0.85) {
                bestScore = matchScore;
                bestMatch = potentialMatch;
            }
        }
        
        if (bestMatch) {
            console.log(`✅ Found Telebirr match with score ${bestScore}!`);
            
            // Determine which is user SMS (SENDER) and which is admin SMS (RECEIVER)
            let userSMS, adminSMS;
            if (analysis.type === 'SENDER') {
                userSMS = smsDeposit;
                adminSMS = bestMatch;
            } else {
                userSMS = bestMatch;
                adminSMS = smsDeposit;
            }
            
            // Auto-approve the match
            try {
                const result = await this.approveTelebirrMatchedSMS(userSMS, adminSMS);
                console.log('✅ Telebirr transaction auto-approved!');
                return result;
            } catch (approvalError) {
                console.error('❌ Error approving Telebirr match:', approvalError);
                return null;
            }
        }
        
        // No immediate match found
        console.log('❌ No Telebirr match found, waiting...');
        
        // Update SMS with Telebirr metadata
        smsDeposit.metadata.telebirrData = {
            transactionId: identifiers.transactionId,
            phoneNumbers: phoneNumbers,
            timestamp: identifiers.time,
            direction: analysis.type,
            matched: false
        };
        
        if (analysis.type === 'SENDER') {
            smsDeposit.metadata.recipientPhone = phoneNumbers[0];
        } else {
            smsDeposit.metadata.senderPhone = phoneNumbers[0];
        }
        
        smsDeposit.status = 'RECEIVED_WAITING_MATCH';
        await smsDeposit.save();
        
        return null;
        
    } catch (error) {
        console.error('❌ Error matching Telebirr SMS:', error);
        return null;
    }
}

// NEW: Helper method to check for duplicate transactions
static async checkForDuplicateTransaction(transactionId, currentSMSId = null) {
    try {
        if (!transactionId) return null;
        
        const query = {
            $or: [
                { extractedReference: transactionId },
                { 'metadata.transactionId': transactionId },
                { 'metadata.cleanReference': transactionId }
            ],
            status: { $in: ['AUTO_APPROVED', 'APPROVED', 'CONFIRMED'] }
        };
        
        if (currentSMSId) {
            query._id = { $ne: currentSMSId };
        }
        
        return await SMSDeposit.findOne(query);
    } catch (error) {
        console.error('❌ Error checking for duplicate transaction:', error);
        return null;
    }
}

      // NEW: Detect payment method from SMS content
    static detectPaymentMethodFromSMS(smsText) {
      const sms = smsText.toLowerCase();
      
      if (sms.includes('cbe') && sms.includes('birr')) return 'CBE Birr';
      if (sms.includes('cbe') && !sms.includes('birr')) return 'CBE Bank';
      if (sms.includes('Abysinia')) return 'Bank of Abysinia';
      if (sms.includes('dashen')) return 'Dashen Bank';
      if (sms.includes('telebirr') || sms.includes('ethio telecom') || sms.includes('ethiotelecom')) return 'Telebirr';
      
      return 'UNKNOWN';
    }

      // NEW: Process stored SMS for deposit
      static async processSMSDeposit(userId, paymentMethodName, smsText, autoApprove = true) {
        const session = await mongoose.startSession();
        session.startTransaction();

        try {
          console.log('🚀 Starting SMS deposit processing...');
          
          const mongoUserId = await this.resolveUserId(userId);
          const user = await User.findById(mongoUserId);
          
          if (!user) {
            throw new Error('User not found');
          }

          console.log('✅ User found:', user.telegramId);

          const paymentMethod = await PaymentMethod.findOne({ 
            name: paymentMethodName
          });
          
          if (!paymentMethod && paymentMethodName !== 'UNKNOWN') {
            throw new Error('Invalid payment method: ' + paymentMethodName);
          }

          console.log('✅ Payment method:', paymentMethodName);

          const amount = this.extractAmountFromSMS(smsText);
          if (!amount || amount <= 0) {
            throw new Error('Could not extract valid amount from SMS.');
          }

          console.log('✅ Amount extracted:', amount);

          let transaction = null;
          let wallet = null;

          // AUTO-APPROVE LOGIC
          const shouldAutoApprove = autoApprove && this.shouldAutoApproveSMS(smsText, amount);
          
          if (shouldAutoApprove) {
            console.log('🤖 Auto-approving deposit...');
            
            wallet = await this.getWallet(mongoUserId);
            const balanceBefore = wallet.balance;
            wallet.balance += amount;
            const balanceAfter = wallet.balance;

            transaction = new Transaction({
              userId: mongoUserId,
              type: 'DEPOSIT',
              amount,
              balanceBefore,
              balanceAfter,
              status: 'COMPLETED',
              description: `Auto-approved deposit via ${paymentMethodName}`,
              reference: `SMS-AUTO-${Date.now()}`,
              metadata: {
                paymentMethod: paymentMethodName,
                smsText: smsText.substring(0, 500),
                approvedBy: 'SYSTEM',
                approvedAt: new Date(),
                autoApproved: true,
                confidence: this.getSMSConfidence(smsText)
              }
            });

            await transaction.save({ session });
            await wallet.save({ session });
            
            console.log(`✅ Auto-approved SMS deposit: $${amount} for user ${user.telegramId}`);
          } else {
            console.log('⏳ Creating pending transaction...');
            
            wallet = await this.getWallet(mongoUserId);
            const balanceBefore = wallet.balance;

            transaction = new Transaction({
              userId: mongoUserId,
              type: 'DEPOSIT',
              amount,
              balanceBefore,
              balanceAfter: balanceBefore,
              status: 'PENDING',
              description: `SMS deposit via ${paymentMethodName} - Needs Review`,
              reference: `SMS-PENDING-${Date.now()}`,
              metadata: {
                paymentMethod: paymentMethodName,
                smsText: smsText.substring(0, 500),
                approvedBy: null,
                approvedAt: null,
                autoApproved: false,
                confidence: this.getSMSConfidence(smsText),
                needsManualReview: true,
                reviewReason: this.getReviewReason(smsText, amount)
              }
            });

            await transaction.save({ session });
          }

          await session.commitTransaction();

          console.log('✅ SMS deposit processed successfully');

          return {
            transaction,
            wallet,
            autoApproved: shouldAutoApprove
          };

        } catch (error) {
          await session.abortTransaction();
          console.error('❌ Error processing SMS deposit:', error);
          throw error;
        } finally {
          session.endSession();
        }
      }
// calculateTelebirrMatchScore


static calculateTelebirrMatchScore(identifiers, smsDeposit) {
    let score = 0;
    const maxScore = 100;
    
    console.log('📊 Calculating Telebirr match score...');
    
    const sms2Text = smsDeposit.originalSMS;
    const sms2Identifiers = this.extractTransactionIdentifiers(sms2Text);
    
    console.log('Comparison:', {
        amount1: identifiers.exactAmount || identifiers.amount,
        amount2: smsDeposit.extractedAmount,
        transactionId1: identifiers.transactionId,
        transactionId2: sms2Identifiers.transactionId,
        time1: identifiers.time,
        time2: sms2Identifiers.time
    });
    
    // 1. Amount match (30 points) - must be exact
    const amount1 = identifiers.exactAmount || identifiers.amount;
    const amount2 = smsDeposit.extractedAmount;
    
    if (amount1 && amount2 && Math.abs(amount1 - amount2) < 0.01) {
        score += 30;
        console.log('✅ Exact amount match');
    } else {
        console.log('⚠️ Amount mismatch');
        return 0;
    }
    
    // 2. Transaction ID match (40 points) - most important for Telebirr
    if (identifiers.transactionId && sms2Identifiers.transactionId) {
        if (identifiers.transactionId === sms2Identifiers.transactionId) {
            score += 40;
            console.log('✅ Exact transaction ID match');
        } else if (smsDeposit.extractedReference === identifiers.transactionId ||
                   smsDeposit.extractedReference === sms2Identifiers.transactionId) {
            score += 35;
            console.log('✅ Reference matches transaction ID');
        } else {
            console.log('⚠️ Transaction ID mismatch');
            return 0;
        }
    } else if (smsDeposit.extractedReference && identifiers.refNumber) {
        // Fallback to reference number match
        if (smsDeposit.extractedReference === identifiers.refNumber) {
            score += 30;
            console.log('✅ Reference number match');
        }
    }
    
    // 3. Time match (15 points) - Telebirr SMS usually within 1-2 minutes
    if (identifiers.time && sms2Identifiers.time) {
        const time1 = this.parseTelebirrTime(identifiers.time);
        const time2 = this.parseTelebirrTime(sms2Identifiers.time);
        
        if (time1 && time2) {
            const timeDiff = Math.abs(time1.getTime() - time2.getTime());
            if (timeDiff <= 2 * 60 * 1000) { // 2 minutes
                score += 15;
                console.log('✅ Time match within 2 minutes');
            } else if (timeDiff <= 5 * 60 * 1000) { // 5 minutes
                score += 10;
                console.log('✅ Time match within 5 minutes');
            }
        }
    }
    
    // 4. Phone number match (15 points)
    const phoneNumbers1 = this.extractPhoneNumbersFromSMS(identifiers.rawSMS || '');
    const phoneNumbers2 = this.extractPhoneNumbersFromSMS(sms2Text);
    
    if (phoneNumbers1.length > 0 && phoneNumbers2.length > 0) {
        const commonPhones = phoneNumbers1.filter(phone => 
            phoneNumbers2.some(p2 => this.normalizePhoneNumber(p2) === this.normalizePhoneNumber(phone))
        );
        
        if (commonPhones.length > 0) {
            score += 15;
            console.log(`✅ Phone number match: ${commonPhones[0]}`);
        }
    }
    
    const percentage = (score / maxScore) * 100;
    console.log(`📈 Telebirr match percentage: ${percentage}% (${score}/${maxScore})`);
    
    return percentage / 100;
}
// NEW: Process existing SMS deposit record
    static async processExistingSMSDeposit(smsDepositId, adminUserId = null) {
      const session = await mongoose.startSession();
      session.startTransaction();

      try {
        console.log('🔄 Processing existing SMS deposit:', smsDepositId);
        
        const smsDeposit = await SMSDeposit.findById(smsDepositId)
          .populate('userId')
          .session(session);
        
        if (!smsDeposit) {
          throw new Error('SMS deposit not found');
        }

        if (smsDeposit.status === 'APPROVED' || smsDeposit.status === 'AUTO_APPROVED') {
          throw new Error('SMS deposit already processed');
        }

        const user = smsDeposit.userId;
        if (!user) {
          throw new Error('User not found');
        }

        const amount = smsDeposit.extractedAmount;
        if (!amount || amount <= 0) {
          throw new Error('Invalid amount in SMS deposit');
        }

        console.log('✅ Processing amount:', amount, 'for user:', user.telegramId);

        // Use user._id directly instead of calling getWallet which tries to resolve
        let wallet = await Wallet.findOne({ userId: user._id }).session(session);
        if (!wallet) {
          console.log('💰 Creating new wallet for user:', user.telegramId);
          wallet = new Wallet({
            userId: user._id,
            balance: 0,
            currency: 'USD'
          });
        }

        const balanceBefore = wallet.balance;
        wallet.balance += amount;
        const balanceAfter = wallet.balance;

        const isAutoApproved = !adminUserId && this.shouldAutoApproveSMS(smsDeposit.originalSMS, amount);
        
        const transaction = new Transaction({
          userId: user._id,
          type: 'DEPOSIT',
          amount,
          balanceBefore,
          balanceAfter,
          status: isAutoApproved ? 'COMPLETED' : 'PENDING',
          description: `${isAutoApproved ? 'Auto-approved' : 'Approved'} deposit via ${smsDeposit.paymentMethod}`,
          reference: `SMS-${isAutoApproved ? 'AUTO' : 'APPROVED'}-${Date.now()}`,
          metadata: {
            paymentMethod: smsDeposit.paymentMethod,
            smsText: smsDeposit.originalSMS.substring(0, 500),
            approvedBy: isAutoApproved ? 'SYSTEM' : adminUserId,
            approvedAt: new Date(),
            autoApproved: isAutoApproved,
            smsDepositId: smsDeposit._id,
            confidence: this.getSMSConfidence(smsDeposit.originalSMS)
          }
        });

        // Update SMS deposit
        smsDeposit.status = isAutoApproved ? 'AUTO_APPROVED' : 'APPROVED';
        smsDeposit.transactionId = transaction._id;
        smsDeposit.autoApproved = isAutoApproved;
        smsDeposit.processedAt = new Date();
        
        if (adminUserId) {
          smsDeposit.processedBy = adminUserId;
        }

        await transaction.save({ session });
        await wallet.save({ session });
        await smsDeposit.save({ session });
        await session.commitTransaction();

        console.log(`✅ Processed SMS deposit: $${amount} for user ${user.telegramId}`);

        return {
          smsDeposit,
          transaction,
          wallet,
          autoApproved: isAutoApproved
        };

      } catch (error) {
        await session.abortTransaction();
        console.error('❌ Error processing existing SMS deposit:', error);
        throw error;
      } finally {
        session.endSession();
      }
    }
      static async getAllSMSDeposits(page = 1, limit = 20, status = null) {
        try {
          const skip = (page - 1) * limit;
          const query = status ? { status } : {};
          
          const [deposits, total] = await Promise.all([
            SMSDeposit.find(query)
              .populate('userId', 'firstName username telegramId')
              .populate('processedBy', 'firstName username')
              .sort({ createdAt: -1 })
              .skip(skip)
              .limit(limit)
              .lean(), // Use lean for better performance
            SMSDeposit.countDocuments(query)
          ]);

          // Ensure all deposits have proper user information
          const enhancedDeposits = deposits.map(deposit => {
            if (!deposit.userId) {
              // If user population failed, create a minimal user object
              deposit.userId = {
                firstName: 'Unknown User',
                username: 'unknown',
                telegramId: deposit.telegramId || 'unknown'
              };
            }
            return deposit;
          });

          return {
            deposits: enhancedDeposits,
            pagination: {
              page,
              limit,
              total,
              pages: Math.ceil(total / limit)
            }
          };
        } catch (error) {
          console.error('❌ Error getting SMS deposits:', error);
          throw error;
        }
      }
    // NEW: Batch approve multiple SMS deposits
      static async batchApproveSMSDeposits(smsDepositIds, adminUserId) {
        const session = await mongoose.startSession();
        session.startTransaction();

        try {
          console.log('🔄 Batch approving SMS deposits:', smsDepositIds);

          const results = {
            successful: [],
            failed: []
          };

          for (const smsDepositId of smsDepositIds) {
            try {
              const result = await this.approveReceivedSMS(smsDepositId, adminUserId);
              results.successful.push({
                smsDepositId,
                amount: result.transaction.amount,
                user: result.user.telegramId
              });
            } catch (error) {
              results.failed.push({
                smsDepositId,
                error: error.message
              });
            }
          }

          await session.commitTransaction();

          console.log(`✅ Batch approval completed: ${results.successful.length} successful, ${results.failed.length} failed`);

          return results;

        } catch (error) {
          await session.abortTransaction();
          console.error('❌ Error in batch approval:', error);
          throw error;
        } finally {
          session.endSession();
        }
      }
      // NEW: Get received SMS for admin
      static async getReceivedSMSDeposits(limit = 50) {
        try {
          return await SMSDeposit.find({ status: 'RECEIVED' })
            .populate('userId', 'firstName username telegramId')
            .sort({ createdAt: 1 })
            .limit(limit);
        } catch (error) {
          console.error('❌ Error getting received SMS deposits:', error);
          throw error;
        }
      }

      // NEW: Admin approve received SMS
    static async approveReceivedSMS(smsDepositId, adminUserId) {
        const session = await mongoose.startSession();
        session.startTransaction();

        try {
          console.log('🔄 Approving received SMS deposit:', smsDepositId);
          
          // Get SMS deposit with user populated
          const smsDeposit = await SMSDeposit.findById(smsDepositId)
            .populate('userId')
            .session(session);
          
          if (!smsDeposit) {
            throw new Error('SMS deposit not found');
          }

          if (smsDeposit.status !== 'RECEIVED' && smsDeposit.status !== 'PENDING') {
            throw new Error(`SMS deposit already ${smsDeposit.status}`);
          }

          // Check if user exists - userId should already be a populated user object
          const user = smsDeposit.userId;
          if (!user) {
            throw new Error('User not found in SMS deposit');
          }
          

          // RESOLVE ADMIN USER ID to MongoDB ObjectId using the helper
          const adminMongoId = await this.resolveAnyUserId(adminUserId);

          const amount = smsDeposit.extractedAmount;
          if (!amount || amount <= 0) {
            throw new Error('Invalid amount in SMS deposit');
          }

          console.log('✅ Processing amount:', amount, 'for user:', user.telegramId, 'by admin:', adminMongoId);

          // Get or create wallet
          let wallet = await Wallet.findOne({ userId: user._id }).session(session);
          if (!wallet) {
            console.log('💰 Creating new wallet for user:', user.telegramId);
            wallet = new Wallet({
              userId: user._id,
              balance: 0,
              currency: 'USD'
            });
          }

          const balanceBefore = wallet.balance;
          wallet.balance += amount;
          const balanceAfter = wallet.balance;

          // Create transaction
          const transaction = new Transaction({
            userId: user._id,
            type: 'DEPOSIT',
            amount,
            balanceBefore,
            balanceAfter,
            status: 'COMPLETED',
            description: `Approved deposit via ${smsDeposit.paymentMethod}`,
            reference: `SMS-APPROVED-${Date.now()}`,
            metadata: {
              paymentMethod: smsDeposit.paymentMethod,
              smsText: smsDeposit.originalSMS.substring(0, 500),
              approvedBy: adminMongoId,
              approvedAt: new Date(),
              autoApproved: false,
              smsDepositId: smsDeposit._id,
              confidence: this.getSMSConfidence(smsDeposit.originalSMS)
            }
          });

          // Update SMS deposit
          smsDeposit.status = 'APPROVED';
          smsDeposit.transactionId = transaction._id;
          smsDeposit.processedBy = adminMongoId;
          smsDeposit.processedAt = new Date();
          smsDeposit.autoApproved = false;

          await transaction.save({ session });
          await wallet.save({ session });
          await smsDeposit.save({ session });
          await session.commitTransaction();

          console.log(`✅ Approved SMS deposit: $${amount} for user ${user.telegramId}`);

          return {
            smsDeposit,
            transaction,
            wallet,
            user,
            autoApproved: false
          };

        } catch (error) {
          await session.abortTransaction();
          console.error('❌ Error approving received SMS deposit:', error);
          throw error;
        } finally {
          session.endSession();
        }
      }
      // Extract phone numbers from Telebirr SMS
static extractPhoneNumbersFromSMS(smsText) {
    const phonePatterns = [
        /(\+2519\d{8})/g,      // +2519xxxxxxxx
        /(2519\d{8})/g,        // 2519xxxxxxxx
        /(09\d{8})/g,          // 09xxxxxxxx
        /(9\d{8})/g,           // 9xxxxxxxx
        /\((\d{4})\*\*\*\*(\d{4})\)/g  // (2519****1353) pattern
    ];
    
    const phones = [];
    
    for (const pattern of phonePatterns) {
        const matches = smsText.match(pattern);
        if (matches) {
            phones.push(...matches);
        }
    }
    
    // Clean up the phone numbers
    const cleanedPhones = phones.map(phone => {
        let cleaned = phone.replace(/\D/g, ''); // Remove non-digits
        if (cleaned.startsWith('251') && cleaned.length === 12) {
            return cleaned;
        } else if (cleaned.startsWith('9') && cleaned.length === 9) {
            return '251' + cleaned;
        } else if (cleaned.startsWith('09') && cleaned.length === 10) {
            return '251' + cleaned.substring(1);
        }
        return cleaned;
    }).filter(phone => phone.length >= 9);
    
    console.log('📱 Extracted phone numbers:', cleanedPhones);
    return cleanedPhones;
}

// Parse Telebirr time format
static parseTelebirrTime(timeString) {
    try {
        // Telebirr format: "02/02/2026 11:11:50"
        if (!timeString) return null;
        
        // Handle format: "02/02/2026 11:11:50"
        const [datePart, timePart] = timeString.split(' ');
        if (datePart && timePart) {
            return new Date(`${datePart} ${timePart}`);
        }
        
        return null;
    } catch (error) {
        console.error('Error parsing Telebirr time:', timeString, error);
        return null;
    }
}

// Normalize phone number for comparison
static normalizePhoneNumber(phone) {
    if (!phone) return '';
    let normalized = phone.replace(/\D/g, '');
    if (normalized.startsWith('251')) {
        return normalized;
    } else if (normalized.startsWith('9') && normalized.length === 9) {
        return '251' + normalized;
    } else if (normalized.startsWith('09') && normalized.length === 10) {
        return '251' + normalized.substring(1);
    }
    return normalized;
}

static async approveTelebirrMatchedSMS(userSMS, adminSMS) {
    const session = await mongoose.startSession();
    session.startTransaction();
    
    try {
        console.log('✅ Approving matched Telebirr SMS pair...');
        
        const user = await User.findById(userSMS.userId).session(session);
        if (!user) throw new Error('User not found for matched Telebirr SMS');
        
        const amount = userSMS.extractedAmount;
        const transactionId = userSMS.metadata?.telebirrData?.transactionId || 
                              adminSMS.metadata?.telebirrData?.transactionId;
        
        console.log(`💰 Processing Telebirr deposit: $${amount} for user ${user.telegramId} (Txn: ${transactionId})`);
        
        // Get or create wallet
        let wallet = await Wallet.findOne({ userId: user._id }).session(session);
        if (!wallet) {
            wallet = new Wallet({
                userId: user._id,
                balance: 0,
                currency: 'USD'
            });
        }
        
        const balanceBefore = wallet.balance;
        wallet.balance += amount;
        const balanceAfter = wallet.balance;
        
        console.log(`💰 Wallet updated: $${balanceBefore} -> $${balanceAfter}`);
        
        // Create transaction
        const transaction = new Transaction({
            userId: user._id,
            type: 'DEPOSIT',
            amount,
            balanceBefore,
            balanceAfter,
            status: 'COMPLETED',
            description: `Telebirr deposit auto-approved (Txn: ${transactionId})`,
            reference: `TELEBIRR-${transactionId || Date.now()}`,
            metadata: {
                paymentMethod: 'Telebirr',
                autoMatched: true,
                matchedType: 'TELEBIRR_AUTO',
                telebirrTransactionId: transactionId,
                senderSMSId: userSMS._id,
                receiverSMSId: adminSMS._id,
                matchedAt: new Date(),
                confidence: 0.95 // High confidence for Telebirr matches
            }
        });
        
        // Update SMS deposits
        userSMS.status = 'AUTO_APPROVED';
        userSMS.transactionId = transaction._id;
        userSMS.autoApproved = true;
        userSMS.processedAt = new Date();
        userSMS.metadata.matched = true;
        userSMS.metadata.matchedWith = adminSMS._id;
        userSMS.metadata.telebirrData = {
            ...userSMS.metadata.telebirrData,
            matched: true,
            matchedAt: new Date()
        };
        
        adminSMS.status = 'CONFIRMED';
        adminSMS.metadata.matched = true;
        adminSMS.metadata.matchedWith = userSMS._id;
        adminSMS.metadata.confirmedAmount = amount;
        adminSMS.metadata.confirmedAt = new Date();
        adminSMS.metadata.telebirrData = {
            ...adminSMS.metadata.telebirrData,
            matched: true,
            matchedAt: new Date()
        };
        
        // Save all changes
        await transaction.save({ session });
        await wallet.save({ session });
        await userSMS.save({ session });
        await adminSMS.save({ session });
        
        await session.commitTransaction();
        
        console.log(`✅ Telebirr deposit COMPLETED: $${amount} added to user ${user.telegramId}'s wallet`);
        
        return {
            transaction,
            wallet,
            userSMS,
            adminSMS,
            autoApproved: true,
            telebirrTransactionId: transactionId,
            amount,
            user
        };
        
    } catch (error) {
        await session.abortTransaction();
        console.error('❌ Error approving Telebirr matched SMS:', error);
        throw error;
    } finally {
        session.endSession();
    }
}
      // NEW: Get unprocessed SMS messages
      static async getUnprocessedSMS(limit = 50) {
        try {
          return await SMSDeposit.find({ status: 'RECEIVED' })
            .populate('userId', 'firstName username telegramId')
            .sort({ createdAt: 1 })
            .limit(limit);
        } catch (error) {
          console.error('❌ Error getting unprocessed SMS:', error);
          throw error;
        }
      }

      // NEW: Auto-process all received SMS
        static async autoProcessReceivedSMS() {
        try {
          const receivedSMS = await SMSDeposit.find({ 
            status: 'RECEIVED_WAITING_MATCH',
            'metadata.smsType': { $in: ['SENDER', 'RECEIVER'] }
          })
          .populate('userId', 'firstName username telegramId')
          .sort({ createdAt: 1 })
          .limit(50);

          console.log(`🔄 Found ${receivedSMS.length} SMS waiting for match`);

          let matchedCount = 0;
          let processingErrors = 0;

          for (const sms of receivedSMS) {
            try {
              // Try to find match for this SMS
              const matchResult = await this.tryAutoMatchSMS(sms, sms.originalSMS);
              
              if (matchResult) {
                matchedCount++;
                console.log(`✅ Matched SMS ${sms._id} with ${matchResult._id}`);
              }
            } catch (error) {
              console.error(`❌ Error processing SMS ${sms._id}:`, error.message);
              processingErrors++;
            }
          }

          return { 
            total: receivedSMS.length, 
            matched: matchedCount,
            errors: processingErrors
          };
        } catch (error) {
          console.error('❌ Error in auto-process SMS:', error);
          throw error;
        }
      }

      // ENHANCED: Analyze SMS type for CBE format
      static analyzeSMSType(smsText) {
        const sms = smsText.toLowerCase();
        
        // Sender SMS patterns (user sent money to admin)
        const senderPatterns = [
          /you have transfered.*etb.*to/i,
          /your account has been debited/i,
          /sent.*etb.*to/i,
          /transfer.*to.*account/i,
          /you have sent.*birr.*to/i,
          /you have transfered etb.*to.*on.*from your account/i, // CBE specific
          /your account has been debited with a s.charge/i // CBE specific
        ];
        
        // Receiver SMS patterns (admin received money from user)
        const receiverPatterns = [
          /your account.*has been credited/i,
          /received.*etb.*from/i,
          /credited with.*etb.*from/i,
          /account.*credited.*with/i,
          /you have received.*birr.*from/i,
          /your account.*has been credited with etb.*from/i // CBE specific
        ];
        
        // Check for sender patterns
        for (const pattern of senderPatterns) {
          if (pattern.test(sms)) {
            return { type: 'SENDER', confidence: 0.9 };
          }
        }
        
        // Check for receiver patterns
        for (const pattern of receiverPatterns) {
          if (pattern.test(sms)) {
            return { type: 'RECEIVER', confidence: 0.9 };
          }
        }
        
        return { type: 'UNKNOWN', confidence: 0.5 };
      }
      static async initializeWallet(userId) {
        try {
          const mongoUserId = await this.resolveUserId(userId);
          
          let wallet = await Wallet.findOne({ userId: mongoUserId });
          
          if (!wallet) {
            wallet = new Wallet({
              userId: mongoUserId,
              balance: 0,
              currency: 'USD'
            });
            await wallet.save();
            console.log(`💰 Wallet initialized for user ${mongoUserId}`);
          }
          
          return wallet;
        } catch (error) {
          console.error('❌ Error initializing wallet:', error);
          throw error;
        }
      }

    static async getWallet(userId) {
      try {
        console.log('🔍 Getting wallet for user:', userId, 'Type:', typeof userId);
        
        let mongoUserId;
        
        // If userId is already a MongoDB ObjectId, use it directly
        if (mongoose.Types.ObjectId.isValid(userId) && new mongoose.Types.ObjectId(userId).toString() === userId) {
          console.log('✅ Input is already MongoDB ObjectId');
          mongoUserId = userId;
        } else {
          // Otherwise, resolve it as a Telegram ID
          console.log('🔍 Resolving Telegram ID to MongoDB ID');
          mongoUserId = await this.resolveUserId(userId);
        }
        
        console.log('✅ Using MongoDB ID:', mongoUserId);
        
        let wallet = await Wallet.findOne({ userId: mongoUserId });
        
        if (!wallet) {
          console.log('💰 No wallet found, initializing new one...');
          wallet = await this.initializeWallet(mongoUserId);
        }
        
        console.log('✅ Wallet found/created:', wallet._id);
        return wallet;
      } catch (error) {
        console.error('❌ Error getting wallet:', error);
        throw error;
      }
    }

      static async getBalance(userId) {
        try {
          console.log('💰 Getting balance for user:', userId);
          const wallet = await this.getWallet(userId);
          console.log('✅ Balance retrieved:', wallet.balance);
          return wallet.balance;
        } catch (error) {
          console.error('❌ Error getting balance:', error);
          throw error;
        }
      }

    static async getWalletByTelegramId(telegramId) {
      try {
        console.log('🔍 Getting wallet by Telegram ID:', telegramId);
        
        // Make sure we're using the exact string format
        const user = await User.findOne({ telegramId: telegramId.toString() });
        
        if (!user) {
          console.error('❌ User not found for Telegram ID:', telegramId);
          throw new Error(`User not found for Telegram ID: ${telegramId}`);
        }
        
        console.log('✅ User found:', user._id, 'Telegram ID:', user.telegramId);
        
        // Use the user's MongoDB ID to find the wallet
        const wallet = await Wallet.findOne({ userId: user._id });
        
        if (!wallet) {
          console.log('💰 No wallet found, creating new one...');
          return await this.initializeWallet(user._id);
        }
        
        console.log('✅ Wallet found:', wallet._id, 'Balance:', wallet.balance);
        return wallet;
        
      } catch (error) {
        console.error('❌ Error getting wallet by Telegram ID:', error);
        throw error;
      }
    }

    static async getBalanceByTelegramId(telegramId) {
      try {
        console.log('💰 Getting balance by Telegram ID:', telegramId);
        const wallet = await this.getWalletByTelegramId(telegramId);
        console.log('✅ Balance retrieved:', wallet.balance);
        return wallet.balance;
      } catch (error) {
        console.error('❌ Error getting balance by Telegram ID:', error);
        throw error;
      }
    }

      // SIMPLIFIED: Process SMS deposit with automatic handling
      static async processSMSDeposit(userId, paymentMethodName, smsText, autoApprove = true) {
        const session = await mongoose.startSession();
        session.startTransaction();

        try {
          console.log('🚀 Starting SMS deposit processing...');
          
          // Resolve user ID
          const mongoUserId = await this.resolveUserId(userId);
          const user = await User.findById(mongoUserId);
          
          if (!user) {
            throw new Error('User not found');
          }

          console.log('✅ User found:', user.telegramId);

          // Get payment method
          const paymentMethod = await PaymentMethod.findOne({ 
            name: paymentMethodName
          });
          
          if (!paymentMethod) {
            throw new Error('Invalid payment method: ' + paymentMethodName);
          }

          console.log('✅ Payment method found:', paymentMethodName);

          // Extract amount from SMS
          const amount = this.extractAmountFromSMS(smsText);
          if (!amount || amount <= 0) {
            throw new Error('Could not extract valid amount from SMS. Please make sure the amount is clearly mentioned.');
          }

          console.log('✅ Amount extracted:', amount);

          // Create SMS deposit record (ALWAYS store the SMS)
          const smsDeposit = new SMSDeposit({
            userId: mongoUserId,
            telegramId: user.telegramId,
            originalSMS: smsText,
            paymentMethod: paymentMethodName,
            extractedAmount: amount,
            status: 'PENDING',
            metadata: {
              smsLength: smsText.length,
              hasTransactionId: smsText.includes('Txn ID') || smsText.includes('Transaction'),
              hasBalance: smsText.includes('balance') || smsText.includes('Balance'),
              processedAt: new Date(),
              autoApproveAttempted: autoApprove
            }
          });

          let transaction = null;
          let wallet = null;

          // AUTO-APPROVE LOGIC: Automatically approve if amount is clear and reasonable
          const shouldAutoApprove = autoApprove && this.shouldAutoApproveSMS(smsText, amount);
          
          if (shouldAutoApprove) {
            console.log('🤖 Auto-approving deposit...');
            
            wallet = await this.getWallet(mongoUserId);
            const balanceBefore = wallet.balance;
            wallet.balance += amount;
            const balanceAfter = wallet.balance;

            // Create completed transaction
            transaction = new Transaction({
              userId: mongoUserId,
              type: 'DEPOSIT',
              amount,
              balanceBefore,
              balanceAfter,
              status: 'COMPLETED',
              description: `Auto-approved deposit via ${paymentMethodName}`,
              reference: `SMS-AUTO-${Date.now()}`,
              metadata: {
                paymentMethod: paymentMethodName,
                smsText: smsText.substring(0, 500),
                approvedBy: 'SYSTEM',
                approvedAt: new Date(),
                autoApproved: true,
                smsDepositId: smsDeposit._id,
                confidence: this.getSMSConfidence(smsText)
              }
            });

            smsDeposit.status = 'AUTO_APPROVED';
            smsDeposit.transactionId = transaction._id;
            smsDeposit.autoApproved = true;
            smsDeposit.processedAt = new Date();

            await transaction.save({ session });
            await wallet.save({ session });
            
            console.log(`✅ Auto-approved SMS deposit: $${amount} for user ${user.telegramId}`);
          } else {
            console.log('⏳ Creating pending SMS deposit for manual review...');
            
            // For unclear amounts or suspicious SMS, create pending transaction
            wallet = await this.getWallet(mongoUserId);
            const balanceBefore = wallet.balance;

            transaction = new Transaction({
              userId: mongoUserId,
              type: 'DEPOSIT',
              amount,
              balanceBefore,
              balanceAfter: balanceBefore,
              status: 'PENDING',
              description: `SMS deposit via ${paymentMethodName} - Needs Review`,
              reference: `SMS-PENDING-${Date.now()}`,
              metadata: {
                paymentMethod: paymentMethodName,
                smsText: smsText.substring(0, 500),
                approvedBy: null,
                approvedAt: null,
                autoApproved: false,
                smsDepositId: smsDeposit._id,
                confidence: this.getSMSConfidence(smsText),
                needsManualReview: true,
                reviewReason: this.getReviewReason(smsText, amount)
              }
            });

            smsDeposit.transactionId = transaction._id;
            smsDeposit.metadata.needsManualReview = true;
            smsDeposit.metadata.reviewReason = this.getReviewReason(smsText, amount);

            await transaction.save({ session });
          }

          // ALWAYS save the SMS deposit record
          await smsDeposit.save({ session });
          await session.commitTransaction();

          console.log('✅ SMS deposit processed successfully');

          return {
            smsDeposit,
            transaction,
            wallet,
            autoApproved: shouldAutoApprove
          };

        } catch (error) {
          await session.abortTransaction();
          console.error('❌ Error processing SMS deposit:', error);
          throw error;
        } finally {
          session.endSession();
        }
      }
    // ========== ENHANCED STORE SMS METHOD FOR CBE ==========
      
static async storeSMSMessage(userId, smsText, paymentMethod = 'UNKNOWN') {
    try {
        console.log('💾 Storing SMS message...');
        
        const mongoUserId = await this.resolveUserId(userId);
        const user = await User.findById(mongoUserId);
        
        if (!user) throw new Error('User not found');
        
        // Analyze SMS first
        const analysis = this.analyzeSMSType(smsText);
        const identifiers = this.extractTransactionIdentifiers(smsText);
        
        const amount = identifiers.exactAmount || identifiers.amount || this.extractAmountFromSMSCBE(smsText);
        const detectedMethod = identifiers.smsBank === 'CBE' ? 'CBE Bank' : 
                             identifiers.smsBank === 'Telebirr' ? 'Telebirr' : paymentMethod;
        
        // Clean reference
        let cleanReference = identifiers.cleanRefNumber;
        if (!cleanReference && identifiers.refNumber) {
            cleanReference = this.cleanCBEReference(identifiers.refNumber);
        }
        
        // Check for duplicate transaction before storing
        const transactionId = identifiers.transactionId || cleanReference;
        if (transactionId) {
            const duplicate = await this.checkForDuplicateTransaction(transactionId);
            if (duplicate) {
                console.log(`❌ Duplicate transaction found: ${transactionId}. Marking as duplicate.`);
                
                // Still store but mark as duplicate
                const smsDeposit = new SMSDeposit({
                    userId: mongoUserId,
                    telegramId: user.telegramId,
                    originalSMS: smsText,
                    paymentMethod: detectedMethod,
                    extractedAmount: amount || 0,
                    extractedReference: cleanReference,
                    status: 'DUPLICATE',
                    smsType: analysis.type,
                    metadata: {
                        smsLength: smsText.length,
                        amountDetected: !!amount,
                        detectedAmount: amount,
                        storedAt: new Date(),
                        autoProcessAttempted: false,
                        confidence: analysis.confidence,
                        bank: identifiers.smsBank,
                        transactionIdentifiers: identifiers,
                        cleanReference: cleanReference,
                        rawReference: identifiers.refNumber,
                        extractionMethod: 'ENHANCED_AMHARIC',
                        duplicateOf: duplicate._id,
                        duplicateReason: 'Duplicate transaction ID',
                        isDuplicate: true
                    }
                });
                
                await smsDeposit.save();
                console.log('✅ Duplicate SMS stored (not processed)');
                return smsDeposit;
            }
        }
        
        console.log('📊 SMS Analysis Results:', {
            amount,
            cleanReference,
            type: analysis.type,
            bank: identifiers.smsBank,
            confidence: analysis.confidence
        });
        
        // Determine SMS type - if analysis is UNKNOWN but we have identifiers, try to infer
        let smsType = analysis.type;
        if (smsType === 'UNKNOWN') {
            // Try to infer from transaction identifiers
            if (identifiers.isCredit) {
                smsType = 'RECEIVER';
                console.log('📥 Inferred RECEIVER from isCredit identifier');
            } else if (identifiers.isDebit) {
                smsType = 'SENDER';
                console.log('📤 Inferred SENDER from isDebit identifier');
            } else if (identifiers.smsBank === 'Telebirr') {
                // Telebirr SMS with "ተቀብለዋል" should be RECEIVER
                if (smsText.includes('ተቀብለዋል')) {
                    smsType = 'RECEIVER';
                    console.log('📥 Inferred RECEIVER for Telebirr deposit');
                }
            }
        }
        
        const smsDeposit = new SMSDeposit({
            userId: mongoUserId,
            telegramId: user.telegramId,
            originalSMS: smsText,
            paymentMethod: detectedMethod,
            extractedAmount: amount || 0,
            extractedReference: cleanReference,
            status: 'RECEIVED',
            smsType: smsType,
            metadata: {
                smsLength: smsText.length,
                amountDetected: !!amount,
                detectedAmount: amount,
                storedAt: new Date(),
                autoProcessAttempted: false,
                confidence: analysis.confidence,
                bank: identifiers.smsBank,
                transactionIdentifiers: identifiers,
                cleanReference: cleanReference,
                rawReference: identifiers.refNumber,
                extractionMethod: 'ENHANCED_AMHARIC',
                // Store original identifiers for debugging
                originalIdentifiers: {
                    isCredit: identifiers.isCredit,
                    isDebit: identifiers.isDebit,
                    time: identifiers.time,
                    senderName: identifiers.senderName,
                    recipientName: identifiers.recipientName
                },
                analysisOverride: smsType !== analysis.type ? {
                    originalAnalysis: analysis.type,
                    inferredType: smsType,
                    reason: 'Inferred from identifiers'
                } : null
            }
        });
        
        await smsDeposit.save();
        
        console.log('✅ SMS stored successfully:', {
            id: smsDeposit._id,
            type: smsDeposit.smsType,
            amount: smsDeposit.extractedAmount,
            reference: smsDeposit.extractedReference,
            bank: smsDeposit.metadata.bank
        });
        
        // Try matching based on bank type
        if (identifiers.smsBank === 'Telebirr' && cleanReference && amount > 0) {
            console.log('🔄 Attempting Telebirr matching...');
            setTimeout(async () => {
                try {
                    const matchResult = await this.matchTelebirrSMS(smsDeposit, smsText);
                    if (matchResult) {
                        console.log('✅ Telebirr match successful!');
                    }
                } catch (matchError) {
                    console.error('❌ Telebirr match failed:', matchError);
                }
            }, 1000);
        }
        
        return smsDeposit;
    } catch (error) {
        console.error('❌ Error storing SMS:', error);
        throw error;
    }
}

      // NEW: Determine if SMS should be auto-approved
      static shouldAutoApproveSMS(smsText, amount) {
        const sms = smsText.toLowerCase();
        
        // Auto-approve conditions
        const conditions = [
          // Amount is reasonable (between 1 and 200)
          amount >= 1 && amount <= 200,
          
          // SMS contains clear transaction indicators
          sms.includes('sent') || sms.includes('received') || sms.includes('transfer'),
          
          // SMS contains amount with currency
          (sms.includes('etb') || sms.includes('birr') || sms.includes('br')),
          
          // SMS has reasonable length (not too short)
          smsText.length > 20,
          
          // Amount matches common deposit patterns
          this.isCommonAmount(amount)
        ];

        // Count how many conditions are met
        const metConditions = conditions.filter(Boolean).length;
        const confidence = metConditions / conditions.length;

        console.log(`🔍 Auto-approve confidence: ${confidence} (${metConditions}/${conditions.length} conditions met)`);

        // Auto-approve if high confidence (at least 80% conditions met)
        return confidence >= 0.8;
      }

      // NEW: Get SMS confidence score
      static getSMSConfidence(smsText) {
        const sms = smsText.toLowerCase();
        let confidence = 0;
        
        // Confidence factors
        if (sms.includes('transaction') || sms.includes('txn')) confidence += 0.3;
        if (sms.includes('sent') || sms.includes('transfer')) confidence += 0.2;
        if (sms.includes('received') || sms.includes('deposit')) confidence += 0.2;
        if (sms.includes('etb') || sms.includes('birr')) confidence += 0.2;
        if (sms.includes('balance')) confidence += 0.1;
        if (smsText.length > 50) confidence += 0.1;
        if (smsText.length > 100) confidence += 0.1;
        
        return Math.min(confidence, 1.0);
      }

      // NEW: Get reason for manual review
      static getReviewReason(smsText, amount) {
        const reasons = [];
        
        if (amount > 200) reasons.push('Large amount');
        if (amount < 1) reasons.push('Very small amount');
        
        const sms = smsText.toLowerCase();
        if (!sms.includes('etb') && !sms.includes('birr') && !sms.includes('br')) {
          reasons.push('No currency mentioned');
        }
        
        if (smsText.length < 30) reasons.push('SMS too short');
        
        if (!sms.includes('sent') && !sms.includes('received') && !sms.includes('transfer')) {
          reasons.push('No transaction verbs');
        }
        
        return reasons.length > 0 ? reasons.join(', ') : 'Low confidence score';
      }

      // NEW: Check if amount is common
      static isCommonAmount(amount) {
        const commonAmounts = [10, 20, 30, 50, 100, 150, 200, 250, 300, 500, 1000];
        return commonAmounts.includes(amount) || (amount % 10 === 0 && amount <= 1000);
      }

      // ENHANCED: Extract amount from SMS with multiple patterns
      static extractAmountFromSMS(smsText) {
        try {
          console.log('🔍 Extracting amount from SMS:', smsText.substring(0, 100));
          
          const patterns = [
            /(\d+\.?\d*)\s*ETB/i,
            /(\d+\.?\d*)\s*Br/i,
            /(\d+\.?\d*)\s*birr/i,
            /amount[:\s]*(\d+\.?\d*)/i,
            /sent\s*(\d+\.?\d*)/i,
            /received\s*(\d+\.?\d*)/i,
            /transfer\s*(\d+\.?\d*)/i,
            /you have sent\s*(\d+\.?\d*)/i,
            /deposit\s*(\d+\.?\d*)/i,
            /(\d+\.?\d*)\s*(?:ETB|Birr|Br)/i,
            /(?:ETB|Birr|Br)\s*(\d+\.?\d*)/i
          ];

          let amount = null;
          
          for (const pattern of patterns) {
            const match = smsText.match(pattern);
            if (match && match[1]) {
              amount = parseFloat(match[1]);
              console.log('✅ Amount extracted with pattern:', pattern, amount);
              if (amount > 0) break;
            }
          }

          // Final fallback - look for any number that could be an amount
          if (!amount || amount <= 0) {
            const numbers = smsText.match(/\d+\.?\d*/g);
            if (numbers) {
              // Filter reasonable amounts (between 1 and 10,000)
              const possibleAmounts = numbers.map(n => parseFloat(n)).filter(n => n >= 1 && n <= 10000);
              if (possibleAmounts.length > 0) {
                amount = possibleAmounts[0];
                console.log('✅ Amount extracted as first reasonable number:', amount);
              }
            }
          }

          return amount;
        } catch (error) {
          console.error('❌ Error extracting amount from SMS:', error);
          return null;
        }
      }

      // Rest of the methods remain the same as previous version...
      static async createDepositRequest(userId, amount, receiptImage, reference, description = 'Bank deposit') {
        const session = await mongoose.startSession();
        session.startTransaction();

        try {
          const mongoUserId = await this.resolveUserId(userId);
          const wallet = await this.getWallet(mongoUserId);
          
          const transaction = new Transaction({
            userId: mongoUserId,
            type: 'DEPOSIT',
            amount,
            balanceBefore: wallet.balance,
            balanceAfter: wallet.balance,
            status: 'PENDING',
            description,
            receiptImage,
            reference,
            metadata: {
              approvedBy: null,
              approvedAt: null
            }
          });

          await transaction.save({ session });
          await session.commitTransaction();

          console.log(`📥 Deposit request created for user ${mongoUserId}: $${amount}`);

          return transaction;
        } catch (error) {
          await session.abortTransaction();
          console.error('❌ Error creating deposit request:', error);
          throw error;
        } finally {
          session.endSession();
        }
      }

      static async approveDeposit(transactionId, adminUserId) {
        const session = await mongoose.startSession();
        session.startTransaction();

        try {
          const transaction = await Transaction.findById(transactionId).session(session);
          
          if (!transaction) {
            throw new Error('Transaction not found');
          }

          if (transaction.status !== 'PENDING') {
            throw new Error(`Transaction already ${transaction.status}`);
          }

          const wallet = await Wallet.findOne({ userId: transaction.userId }).session(session);
          
          if (!wallet) {
            throw new Error('Wallet not found');
          }

          const balanceBefore = wallet.balance;
          wallet.balance += transaction.amount;
          const balanceAfter = wallet.balance;

          transaction.balanceBefore = balanceBefore;
          transaction.balanceAfter = balanceAfter;
          transaction.status = 'COMPLETED';
          transaction.metadata.approvedBy = adminUserId;
          transaction.metadata.approvedAt = new Date();

          await wallet.save({ session });
          await transaction.save({ session });
          await session.commitTransaction();

          console.log(`✅ Deposit approved: $${transaction.amount} for user ${transaction.userId}`);

          return { wallet, transaction };
        } catch (error) {
          await session.abortTransaction();
          console.error('❌ Error approving deposit:', error);
          throw error;
        } finally {
          session.endSession();
        }
      }

      static async approveSMSDeposit(smsDepositId, adminUserId) {
        const session = await mongoose.startSession();
        session.startTransaction();

        try {
          const smsDeposit = await SMSDeposit.findById(smsDepositId).session(session);
          
          if (!smsDeposit) {
            throw new Error('SMS deposit not found');
          }

          if (smsDeposit.status !== 'PENDING') {
            throw new Error(`SMS deposit already ${smsDeposit.status}`);
          }

          const wallet = await this.getWallet(smsDeposit.userId);
          const balanceBefore = wallet.balance;
          wallet.balance += smsDeposit.extractedAmount;
          const balanceAfter = wallet.balance;

          const transaction = new Transaction({
            userId: smsDeposit.userId,
            type: 'DEPOSIT',
            amount: smsDeposit.extractedAmount,
            balanceBefore,
            balanceAfter,
            status: 'COMPLETED',
            description: `Approved deposit via ${smsDeposit.paymentMethod}`,
            reference: `SMS-APPROVED-${Date.now()}`,
            metadata: {
              paymentMethod: smsDeposit.paymentMethod,
              smsText: smsDeposit.originalSMS.substring(0, 500),
              approvedBy: adminUserId,
              approvedAt: new Date(),
              smsDepositId: smsDeposit._id
            }
          });

          smsDeposit.status = 'APPROVED';
          smsDeposit.transactionId = transaction._id;
          smsDeposit.processedBy = adminUserId;
          smsDeposit.processedAt = new Date();

          await transaction.save({ session });
          await wallet.save({ session });
          await smsDeposit.save({ session });
          await session.commitTransaction();

          console.log(`✅ Manual approved SMS deposit: $${smsDeposit.extractedAmount} for user ${smsDeposit.telegramId}`);

          return {
            smsDeposit,
            transaction,
            wallet
          };

        } catch (error) {
          await session.abortTransaction();
          console.error('❌ Error approving SMS deposit:', error);
          throw error;
        } finally {
          session.endSession();
        }
      }

      static async rejectSMSDeposit(smsDepositId, adminUserId, reason = '') {
        try {
          const smsDeposit = await SMSDeposit.findById(smsDepositId);
          
          if (!smsDeposit) {
            throw new Error('SMS deposit not found');
          }

          if (smsDeposit.status !== 'PENDING') {
            throw new Error(`SMS deposit already ${smsDeposit.status}`);
          }

          smsDeposit.status = 'REJECTED';
          smsDeposit.processedBy = adminUserId;
          smsDeposit.processedAt = new Date();
          smsDeposit.metadata.rejectionReason = reason;

          await smsDeposit.save();

          console.log(`❌ Rejected SMS deposit: $${smsDeposit.extractedAmount} for user ${smsDeposit.telegramId}`);

          return smsDeposit;
        } catch (error) {
          console.error('❌ Error rejecting SMS deposit:', error);
          throw error;
        }
      }

      static async getPendingSMSDeposits(limit = 50) {
        try {
          return await SMSDeposit.find({ status: 'PENDING' })
            .populate('userId', 'firstName username telegramId')
            .sort({ createdAt: 1 })
            .limit(limit);
        } catch (error) {
          console.error('❌ Error getting pending SMS deposits:', error);
          throw error;
        }
      }
      // NEW: Get SMS deposits by reference
      static async getSMSDepositsByReference(reference, limit = 10) {
        try {
          const deposits = await SMSDeposit.find({
            $or: [
              { extractedReference: reference },
              { 'metadata.refNumber': reference },
              { 'metadata.rawRefNumber': reference }
            ]
          })
          .populate('userId', 'firstName username telegramId')
          .sort({ createdAt: -1 })
          .limit(limit);
          
          return deposits;
        } catch (error) {
          console.error('❌ Error getting SMS deposits by reference:', error);
          throw error;
        }
      }

      static async getSMSDepositStats() {
        try {
          const stats = await SMSDeposit.aggregate([
            {
              $facet: {
                totalCount: [{ $count: 'count' }],
                byStatus: [
                  { $group: { _id: '$status', count: { $sum: 1 } } }
                ],
                byType: [
                  { $group: { _id: '$smsType', count: { $sum: 1 } } }
                ],
                byPaymentMethod: [
                  { $group: { _id: '$paymentMethod', count: { $sum: 1 } } }
                ],
                withReference: [
                  { $match: { extractedReference: { $exists: true, $ne: null } } },
                  { $count: 'count' }
                ],
                dailyStats: [
                  {
                    $group: {
                      _id: {
                        $dateToString: { format: '%Y-%m-%d', date: '$createdAt' }
                      },
                      count: { $sum: 1 },
                      totalAmount: { $sum: '$extractedAmount' }
                    }
                  },
                  { $sort: { _id: -1 } },
                  { $limit: 7 }
                ]
              }
            }
          ]);
          
          return stats[0];
        } catch (error) {
          console.error('❌ Error getting SMS deposit stats:', error);
          throw error;
        }
      }

      static async processAutoApproveDeposits(maxAutoApproveAmount = 100) {
        try {
          const pendingDeposits = await this.getPendingSMSDeposits();
          let approvedCount = 0;

          for (const deposit of pendingDeposits) {
            if (deposit.extractedAmount <= maxAutoApproveAmount && this.shouldAutoApproveSMS(deposit.originalSMS, deposit.extractedAmount)) {
              try {
                await this.approveSMSDeposit(deposit._id, 'SYSTEM_AUTO');
                approvedCount++;
                console.log(`✅ Auto-approved deposit ${deposit._id} for $${deposit.extractedAmount}`);
              } catch (error) {
                console.error(`❌ Failed to auto-approve deposit ${deposit._id}:`, error);
              }
            }
          }

          return { processed: pendingDeposits.length, approved: approvedCount };
        } catch (error) {
          console.error('❌ Error in auto-approve process:', error);
          throw error;
        }
      }

      static async initializePaymentMethods() {
        const paymentMethods = [
          {
            name: 'CBE Bank',
            type: 'BANK',
            accountName: 'Bingo Game',
            accountNumber: '1000143822668',
            instructions: 'Send money to CBE account 1000143822668 via CBE Birr or bank transfer',
            smsFormat: 'You have received|ETB|from|CBE'
          },
          {
            name: 'BOA',
            type: 'BANK', 
            accountName: 'Bingo Game',
            accountNumber: '145633257',
            instructions: 'Send money to Bank of Abysinia account 145633257',
            smsFormat: 'You have received|ETB|from|Awash'
          },
          // {
          //   name: 'Dashen Bank',
          //   type: 'BANK',
          //   accountName: 'Bingo Game',
          //   accountNumber: '3000400050006000',
          //   instructions: 'Send money to Dashen Bank account 3000400050006000',
          //   smsFormat: 'You have received|ETB|from|Dashen'
          // },
          // {
          //   name: 'CBE Birr',
          //   type: 'MOBILE_MONEY',
          //   accountName: 'Bingo Game',
          //   accountNumber: '0911000000',
          //   instructions: 'Send money to CBE Birr 0911000000',
          //   smsFormat: 'You have received|ETB|from|CBEBirr'
          // },
          {
            name: 'Telebirr',
            type: 'MOBILE_MONEY',
            accountName: 'Bingo Game',
            accountNumber: '0968546687',
            instructions: 'Send money to Telebirr 0968546687',
            smsFormat: 'You have received|ETB|from|Telebirr'
          }
        ];

        for (const method of paymentMethods) {
          await PaymentMethod.findOneAndUpdate(
            { name: method.name },
            method,
            { upsert: true, new: true }
          );
        }
        console.log('✅ Payment methods initialized');
      }
    // NEW: Update SMS deposit with reference
      static async updateSMSDepositReference(smsDepositId, reference) {
        try {
          const smsDeposit = await SMSDeposit.findById(smsDepositId);
          if (!smsDeposit) {
            throw new Error('SMS deposit not found');
          }
          
          smsDeposit.extractedReference = reference;
          smsDeposit.metadata.refNumber = reference;
          smsDeposit.metadata.refUpdatedAt = new Date();
          
          await smsDeposit.save();
          
          console.log(`✅ Updated reference for SMS ${smsDepositId}: ${reference}`);
          
          return smsDeposit;
        } catch (error) {
          console.error('❌ Error updating SMS deposit reference:', error);
          throw error;
        }
      }

      // NEW: Find unmatched SMS by reference
      static async findUnmatchedByReference() {
        try {
          // Find SMS with references but no match
          const unmatched = await SMSDeposit.aggregate([
            {
              $match: {
                status: 'RECEIVED_WAITING_MATCH',
                extractedReference: { $exists: true, $ne: null }
              }
            },
            {
              $group: {
                _id: '$extractedReference',
                count: { $sum: 1 },
                deposits: { $push: '$$ROOT' },
                totalAmount: { $sum: '$extractedAmount' }
              }
            },
            {
              $match: {
                count: { $gte: 2 } // Find references with 2 or more deposits
              }
            },
            {
              $sort: { count: -1 }
            }
          ]);
          
          // Populate user info for each deposit
          for (const group of unmatched) {
            for (let i = 0; i < group.deposits.length; i++) {
              const deposit = await SMSDeposit.findById(group.deposits[i]._id)
                .populate('userId', 'firstName username telegramId');
              group.deposits[i] = deposit;
            }
          }
          
          return unmatched;
        } catch (error) {
          console.error('❌ Error finding unmatched by reference:', error);
          throw error;
        }
      }
      // Other existing methods...
      static async deductGameEntry(userId, gameId, entryFee, description = 'Game entry fee') {
        const session = await mongoose.startSession();
        session.startTransaction();

        try {
          const mongoUserId = await this.resolveUserId(userId);
          const wallet = await Wallet.findOne({ userId: mongoUserId }).session(session);
          
          if (!wallet) {
            throw new Error('Wallet not found');
          }

          if (wallet.balance < entryFee) {
            throw new Error('Insufficient balance for game entry');
          }

          const balanceBefore = wallet.balance;
          wallet.balance -= entryFee;
          const balanceAfter = wallet.balance;

          const transaction = new Transaction({
            userId: mongoUserId,
            type: 'GAME_ENTRY',
            amount: -entryFee,
            balanceBefore,
            balanceAfter,
            status: 'COMPLETED',
            description,
            gameId
          });

          await wallet.save({ session });
          await transaction.save({ session });
          await session.commitTransaction();

          console.log(`🎮 Game entry fee deducted for user ${mongoUserId}: $${entryFee}. New balance: $${balanceAfter}`);

          return { wallet, transaction };
        } catch (error) {
          await session.abortTransaction();
          console.error('❌ Error deducting game entry:', error);
          throw error;
        } finally {
          session.endSession();
        }
      }

    static async addWinning(userId, gameId, amount, description = 'Game winning') {
      const session = await mongoose.startSession();
      session.startTransaction();

      try {
        // NEW: Handle both ObjectId and Telegram ID
        let mongoUserId;
        if (mongoose.Types.ObjectId.isValid(userId) && new mongoose.Types.ObjectId(userId).toString() === userId) {
          mongoUserId = userId; // Already ObjectId
        } else {
          mongoUserId = await this.resolveUserId(userId); // Need to resolve Telegram ID
        }
        
        const wallet = await Wallet.findOne({ userId: mongoUserId }).session(session);
        
        if (!wallet) {
          throw new Error('Wallet not found');
        }

        const balanceBefore = wallet.balance;
        wallet.balance += amount;
        const balanceAfter = wallet.balance;

        const transaction = new Transaction({
          userId: mongoUserId,
          type: 'WINNING',
          amount,
          balanceBefore,
          balanceAfter,
          status: 'COMPLETED',
          description,
          gameId
        });

        await wallet.save({ session });
        await transaction.save({ session });
        await session.commitTransaction();

        console.log(`🏆 Winning added for user ${mongoUserId}: $${amount}. New balance: $${balanceAfter}`);

        return { wallet, transaction };
      } catch (error) {
        await session.abortTransaction();
        console.error('❌ Error adding winning:', error);
        throw error;
      } finally {
        session.endSession();
      }
    }

      static async getTransactionHistory(userId, limit = 10, page = 1) {
        try {
          const mongoUserId = await this.resolveUserId(userId);
          const skip = (page - 1) * limit;
          
          const transactions = await Transaction.find({ userId: mongoUserId })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .populate('gameId', 'code');
          
          const total = await Transaction.countDocuments({ userId: mongoUserId });
          
          return {
            transactions,
            pagination: {
              page,
              limit,
              total,
              pages: Math.ceil(total / limit)
            }
          };
        } catch (error) {
          console.error('❌ Error getting transaction history:', error);
          throw error;
        }
      }

      static async getPendingDeposits() {
        try {
          return await Transaction.find({
            type: 'DEPOSIT',
            status: 'PENDING'
          })
          .populate('userId', 'username firstName telegramId')
          .sort({ createdAt: 1 });
        } catch (error) {
          console.error('❌ Error getting pending deposits:', error);
          throw error;
        }
      }

      static async getUserTransactions(userId) {
        try {
          const mongoUserId = await this.resolveUserId(userId);
          
          return await Transaction.find({ userId: mongoUserId })
            .sort({ createdAt: -1 })
            .limit(10);
        } catch (error) {
          console.error('❌ Error getting user transactions:', error);
          throw error;
        }
      }

      //helpers
      // Add this method to WalletService
    static async checkUserExists(userId) {
      try {
        const user = await User.findById(userId);
        return !!user;
      } catch (error) {
        console.error('Error checking user existence:', error);
        return false;
      }
    }

    // And update the getSMSDepositById method to handle missing users
    static async getSMSDepositById(smsDepositId) {
      try {
        const smsDeposit = await SMSDeposit.findById(smsDepositId)
          .populate('userId', 'firstName username telegramId')
          .populate('processedBy', 'firstName username');
        
        // If user population failed but we have telegramId, create a minimal user object
        if (!smsDeposit.userId && smsDeposit.telegramId) {
          smsDeposit.userId = {
            firstName: 'Unknown User',
            username: 'unknown',
            telegramId: smsDeposit.telegramId
          };
        }
        
        return smsDeposit;
      } catch (error) {
        console.error('❌ Error getting SMS deposit by ID:', error);
        throw error;
      }
    }
    static async resolveAnyUserId(userId) {
      try {
        console.log('🔄 Resolving any user ID:', userId, 'Type:', typeof userId);
        
        // If it's already a valid MongoDB ObjectId, return it
        if (mongoose.Types.ObjectId.isValid(userId) && new mongoose.Types.ObjectId(userId).toString() === userId) {
          console.log('✅ Input is already MongoDB ObjectId');
          return userId;
        }
        
        // Otherwise, treat it as a Telegram ID and look up the user
        console.log('🔍 Looking for user with Telegram ID:', userId.toString());
        const user = await User.findOne({ telegramId: userId.toString() });
        
        if (!user) {
          console.error('❌ User not found for ID:', userId);
          throw new Error(`User not found for ID: ${userId}`);
        }
        
        console.log(`✅ Resolved ID ${userId} to MongoDB ID ${user._id}`);
        return user._id;
        
      } catch (error) {
        console.error('❌ Error resolving user ID:', error);
        throw error;
      }
    }

    static async ensureUserAndWallet(telegramUserData) {
      try {
        console.log('👤 Ensuring user exists and has wallet:', telegramUserData);
        
        let user = await User.findOne({ telegramId: telegramUserData.id.toString() });
        
        if (!user) {
          console.log('➕ Creating new user...');
          user = new User({
            telegramId: telegramUserData.id.toString(),
            firstName: telegramUserData.first_name,
            lastName: telegramUserData.last_name,
            username: telegramUserData.username,
            telegramUsername: telegramUserData.username,
            role: 'user',
            permissions: ['play_games', 'view_games'],
            isActive: true
          });
          
          await user.save();
          console.log('✅ New user created:', user._id);
        }
        
        // Ensure wallet exists
        const wallet = await this.initializeWallet(user._id);
        
        return { user, wallet };
      } catch (error) {
        console.error('❌ Error ensuring user and wallet:', error);
        throw error;
      }
    }


    // auto balance
    // NEW: Get wallet with auto user resolution
    static async getWalletAuto(userIdentifier) {
      try {
        console.log('💰 Getting wallet with auto resolution for:', userIdentifier);
        
        const mongoUserId = await this.resolveAnyUserId(userIdentifier);
        return await this.getWallet(mongoUserId);
      } catch (error) {
        console.error('❌ Error in getWalletAuto:', error);
        throw error;
      }
    }

    // NEW: Get balance with auto user resolution
    static async getBalanceAuto(userIdentifier) {
      try {
        console.log('💰 Getting balance with auto resolution for:', userIdentifier);
        
        const wallet = await this.getWalletAuto(userIdentifier);
        return wallet.balance;
      } catch (error) {
        console.error('❌ Error in getBalanceAuto:', error);
        throw error;
      }
    }
    // NEW: Bulk operations for multiple users
    static async getBalancesForUsers(userIds) {
      try {
        console.log('💰 Getting balances for multiple users:', userIds.length);
        
        const resolvedIds = await Promise.all(
          userIds.map(id => this.resolveAnyUserId(id).catch(() => null))
        );
        
        const validIds = resolvedIds.filter(id => id !== null);
        
        const wallets = await Wallet.find({ 
          userId: { $in: validIds } 
        }).populate('userId', 'telegramId firstName username');
        
        const balanceMap = {};
        wallets.forEach(wallet => {
          balanceMap[wallet.userId.telegramId] = wallet.balance;
          balanceMap[wallet.userId._id.toString()] = wallet.balance;
        });
        
        return balanceMap;
      } catch (error) {
        console.error('❌ Error getting balances for multiple users:', error);
        throw error;
      }
    }

    // NEW: Transaction summary for dashboard
    static async getTransactionSummary(userId, days = 30) {
      try {
        const mongoUserId = await this.resolveAnyUserId(userId);
        
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days);
        
        const summary = await Transaction.aggregate([
          {
            $match: {
              userId: new mongoose.Types.ObjectId(mongoUserId),
              createdAt: { $gte: startDate },
              status: 'COMPLETED'
            }
          },
          {
            $group: {
              _id: '$type',
              totalAmount: { $sum: '$amount' },
              count: { $sum: 1 }
            }
          }
        ]);
        
        const totalDeposits = summary.find(s => s._id === 'DEPOSIT')?.totalAmount || 0;
        const totalWinnings = summary.find(s => s._id === 'WINNING')?.totalAmount || 0;
        const totalGameEntries = Math.abs(summary.find(s => s._id === 'GAME_ENTRY')?.totalAmount || 0);
        
        return {
          totalDeposits,
          totalWinnings,
          totalGameEntries,
          netBalance: totalDeposits + totalWinnings - totalGameEntries,
          transactionCount: summary.reduce((acc, curr) => acc + curr.count, 0),
          period: `${days} days`
        };
      } catch (error) {
        console.error('❌ Error getting transaction summary:', error);
        throw error;
      }
    }

    // NEW: Wallet health check
    static async walletHealthCheck() {
      try {
        const totalWallets = await Wallet.countDocuments();
        const walletsWithBalance = await Wallet.countDocuments({ balance: { $gt: 0 } });
        const recentTransactions = await Transaction.countDocuments({
          createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
        });
        
        const orphanedWallets = await Wallet.aggregate([
          {
            $lookup: {
              from: 'users',
              localField: 'userId',
              foreignField: '_id',
              as: 'user'
            }
          },
          {
            $match: {
              user: { $size: 0 }
            }
          },
          {
            $count: 'orphanedCount'
          }
        ]);
        
        const orphanedCount = orphanedWallets[0]?.orphanedCount || 0;
        
        return {
          status: 'healthy',
          timestamp: new Date().toISOString(),
          statistics: {
            totalWallets,
            walletsWithBalance,
            activeWalletsPercentage: Math.round((walletsWithBalance / totalWallets) * 100),
            recentTransactions24h: recentTransactions,
            orphanedWallets: orphanedCount
          },
          issues: orphanedCount > 0 ? [`${orphanedCount} orphaned wallets found`] : []
        };
      } catch (error) {
        console.error('❌ Wallet health check error:', error);
        return {
          status: 'unhealthy',
          error: error.message,
          timestamp: new Date().toISOString()
        };
      }
    }


    //withdrawal, transfer, bet deduction etc

    // Withdrawal Request

    static async createWithdrawalRequest(userId, amount, method, accountDetails) {
      const session = await mongoose.startSession();
      session.startTransaction();

      try {
        console.log('📤 Creating withdrawal request for user:', userId);
        
        const mongoUserId = await this.resolveAnyUserId(userId);
        const user = await User.findById(mongoUserId);
        
        if (!user) {
          throw new Error('User not found');
        }

        // Get wallet and check balance
        const wallet = await Wallet.findOne({ userId: mongoUserId }).session(session);
        if (!wallet) {
          throw new Error('Wallet not found');
        }

        // Check if user has pending withdrawal
        const pendingWithdrawal = await Transaction.findOne({
          userId: mongoUserId,
          type: 'WITHDRAWAL',
          status: 'PENDING'
        }).session(session);

        if (pendingWithdrawal) {
          throw new Error('You already have a pending withdrawal request');
        }

        // Validate minimum withdrawal amount
        const minWithdrawal = 10;
        if (amount < minWithdrawal) {
          throw new Error(`Minimum withdrawal amount is $${minWithdrawal}`);
        }

        // Calculate available balance
        const availableBalance = wallet.balance - (wallet.lockedAmount || 0);
        if (availableBalance < amount) {
          throw new Error(`Insufficient available balance. Available: $${availableBalance}`);
        }

        // Lock the amount (increase lockedAmount, DON'T touch balance)
        const balanceBefore = wallet.balance;
        wallet.lockedAmount = (wallet.lockedAmount || 0) + amount;
        const availableAfter = wallet.balance - wallet.lockedAmount;

        console.log(`💰 Locking amount: ${amount}`);
        console.log(`💰 Balance: ${wallet.balance}, Locked: ${wallet.lockedAmount}, Available: ${availableAfter}`);

        const withdrawal = new Transaction({
          userId: mongoUserId,
          type: 'WITHDRAWAL',
          amount: -amount,
          balanceBefore: wallet.balance,
          balanceAfter: wallet.balance, // Balance doesn't change until approval
          status: 'PENDING',
          description: `Withdrawal request via ${method}`,
          reference: `WITHDRAW-${Date.now()}`,
          metadata: {
            withdrawalMethod: method,
            accountDetails: accountDetails,
            requestedAmount: amount,
            processedBy: null,
            processedAt: null,
            isLocked: true,
            lockedAt: new Date(),
            lockedAmount: amount,
            availableBeforeLock: availableBalance,
            availableAfterLock: availableAfter
          }
        });

        await wallet.save({ session });
        await withdrawal.save({ session });
        await session.commitTransaction();

        console.log(`✅ Withdrawal request created for user ${user.telegramId}: $${amount}`);
        console.log(`💰 Wallet state - Balance: $${wallet.balance}, Locked: $${wallet.lockedAmount}, Available: $${availableAfter}`);

        return {
          withdrawal,
          user,
          wallet,
          availableBalance: availableAfter,
          lockedAmount: wallet.lockedAmount
        };

      } catch (error) {
        await session.abortTransaction();
        console.error('❌ Error creating withdrawal request:', error);
        throw error;
      } finally {
        session.endSession();
      }
    }

    // Get user's withdrawal history
    static async getUserWithdrawals(userId, limit = 10) {
      try {
        const mongoUserId = await this.resolveAnyUserId(userId);
        
        return await Transaction.find({
          userId: mongoUserId,
          type: 'WITHDRAWAL'
        })
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();
      } catch (error) {
        console.error('❌ Error getting user withdrawals:', error);
        throw error;
      }
    }
    // Add this method to WalletService.js
    static async getTransactionStats() {
      try {
        const stats = await Transaction.aggregate([
          {
            $facet: {
              totalCount: [{ $count: 'count' }],
              totalAmount: [
                { $group: { _id: null, total: { $sum: '$amount' } } }
              ],
              byType: [
                { $group: { 
                  _id: '$type', 
                  count: { $sum: 1 }, 
                  totalAmount: { $sum: '$amount' } 
                } }
              ],
              byStatus: [
                { $group: { 
                  _id: '$status', 
                  count: { $sum: 1 }, 
                  totalAmount: { $sum: '$amount' } 
                } }
              ],
              dailyStats: [
                {
                  $group: {
                    _id: {
                      $dateToString: { format: '%Y-%m-%d', date: '$createdAt' }
                    },
                    count: { $sum: 1 },
                    totalAmount: { $sum: '$amount' }
                  }
                },
                { $sort: { _id: -1 } },
                { $limit: 7 }
              ]
            }
          }
        ]);
        
        return stats[0];
      } catch (error) {
        console.error('❌ Error getting transaction stats:', error);
        throw error;
      }
    }
    // Get available balance (excluding locked amounts)
    static async getAvailableBalance(userId) {
      try {
        const mongoUserId = await this.resolveAnyUserId(userId);
        
        const wallet = await Wallet.findOne({ userId: mongoUserId });
        if (!wallet) {
          return { totalBalance: 0, lockedAmount: 0, availableBalance: 0 };
        }

        const lockedAmount = wallet.lockedAmount || 0;
        const availableBalance = Math.max(0, wallet.balance - lockedAmount);

        console.log(`💰 Balance check for ${userId}:`);
        console.log(`   Total Balance: $${wallet.balance}`);
        console.log(`   Locked Amount: $${lockedAmount}`);
        console.log(`   Available: $${availableBalance}`);

        return {
          totalBalance: wallet.balance,
          lockedAmount,
          availableBalance
        };
      } catch (error) {
        console.error('❌ Error getting available balance:', error);
        throw error;
      }
    }

    // Admin: Get all pending withdrawals
    static async getPendingWithdrawals(limit = 50) {
      try {
        return await Transaction.find({
          type: 'WITHDRAWAL',
          status: 'PENDING'
        })
        .populate('userId', 'firstName username telegramId')
        .sort({ createdAt: 1 })
        .limit(limit)
        .lean();
      } catch (error) {
        console.error('❌ Error getting pending withdrawals:', error);
        throw error;
      }
    }

    // Admin: Approve withdrawal
    static async approveWithdrawal(transactionId, adminUserId) {
      const session = await mongoose.startSession();
      session.startTransaction();

      try {
        console.log('✅ Admin approving withdrawal:', transactionId);
        
        const withdrawal = await Transaction.findById(transactionId)
          .populate('userId')
          .session(session);
        
        if (!withdrawal) {
          throw new Error('Withdrawal request not found');
        }

        if (withdrawal.status !== 'PENDING') {
          throw new Error(`Withdrawal already ${withdrawal.status}`);
        }

        if (withdrawal.type !== 'WITHDRAWAL') {
          throw new Error('Transaction is not a withdrawal');
        }

        const user = withdrawal.userId;
        const amount = Math.abs(withdrawal.amount);

        // Get wallet
        const wallet = await Wallet.findOne({ userId: user._id }).session(session);
        if (!wallet) {
          throw new Error('Wallet not found');
        }

        // Check if locked amount is sufficient
        if ((wallet.lockedAmount || 0) < amount) {
          throw new Error('Insufficient locked amount');
        }

        // ✅ Actually deduct from balance and reduce locked amount
        const balanceBefore = wallet.balance;
        wallet.balance -= amount;
        wallet.lockedAmount = Math.max(0, (wallet.lockedAmount || 0) - amount);
        const balanceAfter = wallet.balance;

        console.log(`💰 Withdrawal approved: Deducting $${amount} from balance`);
        console.log(`💰 New balance: ${balanceBefore} -> ${balanceAfter}`);
        console.log(`💰 New locked amount: ${wallet.lockedAmount}`);

        // Update withdrawal transaction
        withdrawal.balanceBefore = balanceBefore;
        withdrawal.balanceAfter = balanceAfter;
        withdrawal.status = 'COMPLETED';
        withdrawal.metadata.processedBy = adminUserId;
        withdrawal.metadata.processedAt = new Date();
        withdrawal.metadata.isLocked = false;
        withdrawal.metadata.completedAt = new Date();
        withdrawal.metadata.actualDeduction = amount;

        // Optional: Create payment record
        const PaymentRecord = mongoose.model('PaymentRecord') || {
          create: async (data) => {
            console.log('Payment record would be created:', data);
            return data;
          }
        };

        const paymentRecord = {
          userId: user._id,
          transactionId: withdrawal._id,
          type: 'WITHDRAWAL',
          amount,
          method: withdrawal.metadata.withdrawalMethod,
          accountDetails: withdrawal.metadata.accountDetails,
          status: 'PAID',
          paidBy: adminUserId,
          paidAt: new Date()
        };

        await wallet.save({ session });
        await withdrawal.save({ session });
        
        try {
          await PaymentRecord.create(paymentRecord, { session });
        } catch (e) {
          console.warn('Could not create payment record:', e.message);
        }
        
        await session.commitTransaction();

        console.log(`✅ Withdrawal approved: $${amount} for user ${user.telegramId}`);
        console.log(`💰 Final state - Balance: $${wallet.balance}, Locked: $${wallet.lockedAmount}`);

        return {
          withdrawal,
          wallet,
          user,
          amount
        };

      } catch (error) {
        await session.abortTransaction();
        console.error('❌ Error approving withdrawal:', error);
        throw error;
      } finally {
        session.endSession();
      }
    }

    // Admin: Reject withdrawal
    static async rejectWithdrawal(transactionId, adminUserId, reason = '') {
      const session = await mongoose.startSession();
      session.startTransaction();

      try {
        console.log('❌ Admin rejecting withdrawal:', transactionId);
        
        const withdrawal = await Transaction.findById(transactionId)
          .populate('userId')
          .session(session);
        
        if (!withdrawal) {
          throw new Error('Withdrawal request not found');
        }

        if (withdrawal.status !== 'PENDING') {
          throw new Error(`Withdrawal already ${withdrawal.status}`);
        }

        const amount = Math.abs(withdrawal.amount);
        
        // Get wallet and unlock the amount
        const wallet = await Wallet.findOne({ userId: withdrawal.userId._id }).session(session);
        if (wallet) {
          // Reduce locked amount (return to available)
          wallet.lockedAmount = Math.max(0, (wallet.lockedAmount || 0) - amount);
          await wallet.save({ session });
          console.log(`💰 Unlocked $${amount} from wallet. New locked amount: $${wallet.lockedAmount}`);
        }

        // Update withdrawal transaction
        withdrawal.status = 'REJECTED';
        withdrawal.metadata.processedBy = adminUserId;
        withdrawal.metadata.processedAt = new Date();
        withdrawal.metadata.isLocked = false;
        withdrawal.metadata.rejectionReason = reason;
        withdrawal.metadata.rejectedAt = new Date();
        withdrawal.metadata.unlockedAmount = amount;

        await withdrawal.save({ session });
        await session.commitTransaction();

        console.log(`❌ Withdrawal rejected: $${amount} for user ${withdrawal.userId.telegramId}`);

        return withdrawal;

      } catch (error) {
        await session.abortTransaction();
        console.error('❌ Error rejecting withdrawal:', error);
        throw error;
      } finally {
        session.endSession();
      }
    }

    // Get withdrawal statistics
    static async getWithdrawalStats() {
      try {
        const stats = await Transaction.aggregate([
          {
            $match: { type: 'WITHDRAWAL' }
          },
          {
            $facet: {
              totalCount: [{ $count: 'count' }],
              byStatus: [
                { $group: { _id: '$status', count: { $sum: 1 }, totalAmount: { $sum: { $abs: '$amount' } } } }
              ],
              dailyStats: [
                {
                  $group: {
                    _id: {
                      $dateToString: { format: '%Y-%m-%d', date: '$createdAt' }
                    },
                    count: { $sum: 1 },
                    totalAmount: { $sum: { $abs: '$amount' } }
                  }
                },
                { $sort: { _id: -1 } },
                { $limit: 7 }
              ],
              totalAmount: [
                { $group: { _id: null, total: { $sum: { $abs: '$amount' } } } }
              ],
              pendingAmount: [
                { $match: { status: 'PENDING' } },
                { $group: { _id: null, total: { $sum: { $abs: '$amount' } } } }
              ]
            }
          }
        ]);
        
        return stats[0];
      } catch (error) {
        console.error('❌ Error getting withdrawal stats:', error);
        throw error;
      }
    }

    }




    module.exports = WalletService;
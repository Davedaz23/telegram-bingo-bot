// services/walletService.js - SIMPLIFIED SMS PROCESSING
const mongoose = require('mongoose');
const Wallet = require('../models/Wallet');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const PaymentMethod = require('../models/PaymentMethod');
const SMSDeposit = require('../models/SMSDeposit');

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

 // NEW: Enhanced SMS matching system with reference storage
 static async matchAndAutoApproveSMS(smsText, telegramId, paymentMethod) {
  const session = await mongoose.startSession();
  let transactionCompleted = false;

  try {
    console.log('🔄 Starting SMS matching and auto-approval...');
    
    session.startTransaction({
      readPreference: 'primary',
      readConcern: { level: 'local' },
      writeConcern: { w: 'majority' }
    });
    
    // First, store the SMS with extracted reference
    const smsDeposit = await this.storeSMSMessage(telegramId, smsText, paymentMethod);
    
    // Analyze SMS type
    const smsAnalysis = this.analyzeSMSType(smsText);
    console.log('🔍 SMS Analysis:', smsAnalysis);
    
    // Extract identifiers including reference
    const identifiers = this.extractTransactionIdentifiers(smsText);
    
    // Store reference in the main field
    if (identifiers.refNumber) {
      smsDeposit.extractedReference = identifiers.refNumber;
      console.log(`💾 Stored reference: ${smsDeposit.extractedReference}`);
    }
    
    // Save the initial SMS deposit
    await smsDeposit.save({ session });
    
    if (smsAnalysis.type === 'SENDER') {
      console.log('📤 This is a SENDER SMS (user sent money)');
      
      // Update with metadata
      smsDeposit.smsType = 'SENDER';
      smsDeposit.metadata.transactionIdentifiers = identifiers;
      smsDeposit.metadata.recipientName = identifiers.recipientName;
      smsDeposit.status = 'RECEIVED_WAITING_MATCH';
      await smsDeposit.save({ session });
      
      // Try to match with existing RECEIVER SMS
      const matchResult = await this.tryAutoMatchSMS(smsDeposit, smsText, session);
      
    } else if (smsAnalysis.type === 'RECEIVER') {
      console.log('📥 This is a RECEIVER SMS (admin received money)');
      
      // Update with metadata
      smsDeposit.smsType = 'RECEIVER';
      smsDeposit.metadata.transactionIdentifiers = identifiers;
      smsDeposit.metadata.senderName = identifiers.senderName;
      smsDeposit.status = 'RECEIVED_WAITING_MATCH';
      await smsDeposit.save({ session });
      
      // Try to match with existing SENDER SMS
      const matchResult = await this.tryAutoMatchSMS(smsDeposit, smsText, session);
      
    } else {
      console.log('❓ Unknown SMS type, storing as regular deposit');
      smsDeposit.status = 'RECEIVED';
      await smsDeposit.save({ session });
    }
    
    await session.commitTransaction();
    transactionCompleted = true;
    
    return smsDeposit;
    
  } catch (error) {
    if (!transactionCompleted) {
      try {
        await session.abortTransaction();
      } catch (abortError) {
        console.warn('⚠️ Could not abort transaction:', abortError.message);
      }
    }
    
    console.error('❌ Error in SMS matching:', error);
    
    // Handle validation errors gracefully
    if (error.message.includes('validation failed') || error.message.includes('enum value')) {
      try {
        const smsDeposit = await SMSDeposit.findOne({
          originalSMS: smsText,
          telegramId: telegramId.toString()
        });
        
        if (smsDeposit) {
          smsDeposit.status = 'RECEIVED';
          await smsDeposit.save();
          return smsDeposit;
        }
      } catch (saveError) {
        console.error('❌ Could not save SMS deposit after error:', saveError);
      }
    }
    
    throw error;
  } finally {
    if (session) {
      session.endSession();
    }
  }
}

// NEW: Analyze SMS type (sender vs receiver)
// ENHANCED: Analyze SMS type for CBE format
  static analyzeSMSType(smsText) {
    const sms = smsText.toLowerCase();
    
    const senderPatterns = [
      /you have transfered.*etb.*to/i,
      /your account has been debited/i,
      /sent.*etb.*to/i,
      /transfer.*to.*account/i,
      /you have sent.*birr.*to/i,
      /you have transfered etb.*to.*on.*from your account/i,
      /your account has been debited with a s.charge/i
    ];
    
    const receiverPatterns = [
      /your account.*has been credited/i,
      /received.*etb.*from/i,
      /credited with.*etb.*from/i,
      /account.*credited.*with/i,
      /you have received.*birr.*from/i,
      /your account.*has been credited with etb.*from/i
    ];
    
    for (const pattern of senderPatterns) {
      if (pattern.test(sms)) {
        return { type: 'SENDER', confidence: 0.9 };
      }
    }
    
    for (const pattern of receiverPatterns) {
      if (pattern.test(sms)) {
        return { type: 'RECEIVER', confidence: 0.9 };
      }
    }
    
    return { type: 'UNKNOWN', confidence: 0.5 };
  }

  static detectBankFromSMS(smsText) {
    const sms = smsText.toLowerCase();
    if (sms.includes('cbe')) return 'CBE';
    if (sms.includes('awash')) return 'Awash';
    if (sms.includes('dashen')) return 'Dashen';
    if (sms.includes('telebirr')) return 'Telebirr';
    return 'UNKNOWN';
  }

  static detectPaymentMethodFromSMS(smsText) {
    const sms = smsText.toLowerCase();
    
    if (sms.includes('cbe') && sms.includes('birr')) return 'CBE Birr';
    if (sms.includes('cbe') && !sms.includes('birr')) return 'CBE Bank';
    if (sms.includes('awash')) return 'Awash Bank';
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
static async tryAutoMatchSMS(newSMSDeposit, smsText, session = null) {
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
        
        // APPROVE THE MATCHED TRANSACTION with session
        const result = await this.approveMatchedSMS(newSMSDeposit, potentialMatch, session);
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
    
    // Use session if provided, otherwise regular save
    if (session) {
      await newSMSDeposit.save({ session });
    } else {
      await newSMSDeposit.save();
    }
    
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
// NEW: Extract transaction identifiers from SMS

// UPDATED: Enhanced reference extraction for both SENDER and RECEIVER SMS
static extractTransactionIdentifiers(smsText) {
  smsText = smsText.trim();
  
  console.log('🔍 EXTRACTING IDENTIFIERS - SMS LENGTH:', smsText.length);
  console.log('📋 FULL SMS:', smsText); // ADD THIS to see the full message
  
  const identifiers = {
    amount: this.extractAmountFromSMS(smsText),
    transactionId: null,
    refNumber: null,
    time: null,
    senderName: null,
    recipientName: null,
    accountNumbers: [],
    smsBank: this.detectBankFromSMS(smsText),
    rawRefNumber: null,
    isCredit: false,
    isDebit: false,
    exactAmount: null
  };

  const sms = smsText.toLowerCase();
  
  // Transaction type detection
  identifiers.isCredit = /credited|received/i.test(smsText);
  identifiers.isDebit = /debited|transfered|sent/i.test(smsText);
  
  console.log('💳 Transaction type - isCredit:', identifiers.isCredit, 'isDebit:', identifiers.isDebit);

  // Extract EXACT amount
  const amountMatch = smsText.match(/ETB\s*([\d,]+\.?\d*)/i);
  if (amountMatch) {
    const cleanAmount = amountMatch[1].replace(/,/g, '');
    identifiers.exactAmount = parseFloat(cleanAmount);
    console.log('💰 Exact amount:', identifiers.exactAmount);
  }

  // ENHANCED: CBE-specific reference extraction
  let foundRef = null;
  let rawRef = null;
  
  console.log('🔎 Looking for CBE URL pattern...');
  
  // Method 1: Find CBE URL pattern (BOTH SENDER AND RECEIVER have this)
  // Pattern: https://apps.cbe.com.et:100/?id=FT253422RPRW11206342
  const cbeUrlPattern = /https?:\/\/apps\.cbe\.com\.et(?::\d+)?\/\?id=([A-Z0-9]+)/i;
  const cbeUrlMatch = smsText.match(cbeUrlPattern);
  
  if (cbeUrlMatch && cbeUrlMatch[1]) {
    rawRef = cbeUrlMatch[1];
    console.log('🎯 Found CBE URL reference:', rawRef);
    
    // Clean the reference by removing account suffix
    foundRef = this.cleanCBEReference(rawRef);
    console.log('🧹 Cleaned reference:', foundRef);
  }
  
  // Method 2: Standard Ref No pattern (mainly for RECEIVER SMS)
  if (!foundRef) {
    console.log('🔎 Looking for Ref No pattern...');
    const refPattern = /Ref\s*No\s*([A-Z0-9]+)/i;
    const refMatch = smsText.match(refPattern);
    if (refMatch) {
      foundRef = refMatch[1];
      console.log('✅ Found Ref No:', foundRef);
    }
  }
  
  // Method 3: FT pattern anywhere in text (fallback)
  if (!foundRef) {
    console.log('🔎 Looking for FT pattern anywhere...');
    const ftPattern = /(FT\d+[A-Z]+)/i;
    const ftMatch = smsText.match(ftPattern);
    if (ftMatch) {
      foundRef = ftMatch[1];
      console.log('✅ Found FT pattern:', foundRef);
    }
  }
  
  // Method 4: Generic id= pattern (for any URL)
  if (!foundRef) {
    console.log('🔎 Looking for generic id= pattern...');
    const genericIdPattern = /id=([A-Z0-9]{10,})/i;
    const genericIdMatch = smsText.match(genericIdPattern);
    if (genericIdMatch) {
      rawRef = genericIdMatch[1];
      console.log('🎯 Found generic id reference:', rawRef);
      foundRef = this.cleanCBEReference(rawRef);
    }
  }
  
  if (foundRef) {
    identifiers.refNumber = foundRef.toUpperCase();
    identifiers.transactionId = identifiers.refNumber;
    identifiers.rawRefNumber = rawRef || foundRef;
    
    console.log('🎯 FINAL Extracted reference:', identifiers.refNumber);
    console.log('📝 Raw reference:', identifiers.rawRefNumber);
  } else {
    console.log('⚠️ No reference found in SMS');
    
    // DEBUG: Show what patterns exist in the SMS
    console.log('🔍 DEBUG - Checking SMS content:');
    console.log('Has "id=":', smsText.includes('id='));
    console.log('Has "FT":', smsText.includes('FT'));
    console.log('Has "Ref":', smsText.includes('Ref'));
    console.log('Has URL:', smsText.includes('http'));
  }

  // Extract time
  const timeMatch = smsText.match(/(\d{2}\/\d{2}\/\d{4})\s*(?:at)?\s*(\d{2}:\d{2}:\d{2})/i);
  if (timeMatch) {
    identifiers.time = `${timeMatch[1]} ${timeMatch[2]}`;
    console.log('⏰ Extracted time:', identifiers.time);
  }

  // Extract names
  if (identifiers.isDebit) {
    // Pattern for SENDER: "to Defar Gobeze"
    const toMatch = smsText.match(/to\s+([A-Za-z\s]+?)(?:,|\.|on|with|from|Your|on)/i);
    if (toMatch) {
      identifiers.recipientName = toMatch[1].trim();
      console.log('👤 Recipient name extracted:', identifiers.recipientName);
    }
  }

  if (identifiers.isCredit) {
    // Pattern for RECEIVER: "from Defar Gobeze"
    const fromMatch = smsText.match(/from\s+([A-Za-z\s]+?)(?:,|\.|on|with|Your|with)/i);
    if (fromMatch) {
      identifiers.senderName = fromMatch[1].trim();
      console.log('👤 Sender name extracted:', identifiers.senderName);
    }
  }

  // Extract masked account number (1*****6342 or 1*6342)
  const accountMatch = smsText.match(/(\d\*+?\d{4})/);
  if (accountMatch) {
    identifiers.accountNumbers = [accountMatch[1]];
    console.log('🏦 Account number:', accountMatch[1]);
  }

  console.log('✅ FINAL IDENTIFIERS:', {
    refNumber: identifiers.refNumber,
    isCredit: identifiers.isCredit,
    isDebit: identifiers.isDebit,
    amount: identifiers.amount,
    exactAmount: identifiers.exactAmount,
    senderName: identifiers.senderName,
    recipientName: identifiers.recipientName,
    time: identifiers.time
  });

  return identifiers;
}

// ENHANCED: Clean CBE reference by removing account suffix
static cleanCBEReference(reference) {
  if (!reference) return null;
  
  const ref = reference.toUpperCase();
  
  console.log(`🧹 Cleaning reference: ${ref}`);
  
  // Check if it's an FT reference
  if (ref.startsWith('FT')) {
    // Check if it's long enough to have an account suffix
    if (ref.length >= 12) {
      const last8 = ref.slice(-8);
      
      // If last 8 characters are all digits, remove them (account suffix)
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
  
  // Not an FT reference, return as-is
  console.log(`✅ Not an FT reference: ${ref}`);
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
  
  // Only process FT references
  if (!ref.startsWith('FT')) {
    return ref;
  }
  
  // Check if it's long enough to have an account suffix
  if (ref.length >= 12) {
    const last8 = ref.slice(-8);
    
    // If last 8 characters are all digits, remove them (account suffix)
    if (/^\d{8}$/.test(last8)) {
      const cleanRef = ref.slice(0, -8);
      console.log(`🧹 Cleaned reference: ${ref} -> ${cleanRef}`);
      return cleanRef;
    }
  }
  
  return ref;
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
    
    // Get identifiers from second SMS (from database)
    const sms2Text = sms2Deposit.originalSMS;
    const sms2Identifiers = this.extractTransactionIdentifiers(sms2Text);
    
    console.log('📊 COMPARING SMS FOR MATCHING:');
    console.log('SMS1 Type:', sms1Identifiers.isCredit ? 'CREDIT' : sms1Identifiers.isDebit ? 'DEBIT' : 'UNKNOWN');
    console.log('SMS2 Type:', sms2Identifiers.isCredit ? 'CREDIT' : sms2Identifiers.isDebit ? 'DEBIT' : 'UNKNOWN');
    console.log('SMS1 Amount:', sms1Identifiers.amount, 'Exact:', sms1Identifiers.exactAmount);
    console.log('SMS2 Amount:', sms2Deposit.extractedAmount, 'DB Ref:', sms2Deposit.extractedReference);
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
      return 0; // Early exit if both are same type
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
    
    // 3. Reference match (30 points) - Use stored extractedReference
    if (sms1Identifiers.refNumber && sms2Deposit.extractedReference) {
      const ref1 = sms1Identifiers.refNumber.toUpperCase();
      const ref2 = sms2Deposit.extractedReference.toUpperCase();
      
      // Exact match
      if (ref1 === ref2) {
        score += 30;
        console.log('✅ Exact reference number match');
      } 
      // Check if one contains the other
      else if (ref1.includes(ref2) || ref2.includes(ref1)) {
        score += 28;
        console.log('✅ Partial reference match');
      }
      // Check metadata references for backward compatibility
      else if (sms2Deposit.metadata?.refNumber) {
        const metaRef = sms2Deposit.metadata.refNumber.toUpperCase();
        if (ref1.includes(metaRef) || metaRef.includes(ref1)) {
          score += 28;
          console.log('✅ Metadata reference match');
        } else {
          console.log('⚠️ Reference number mismatch');
          return 0;
        }
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
    if (sms.includes('cbe')) return 'CBE';
    if (sms.includes('awash')) return 'Awash';
    if (sms.includes('dashen')) return 'Dashen';
    if (sms.includes('telebirr')) return 'Telebirr';
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

  // ENHANCED: Approve matched SMS
  static async approveMatchedSMS(senderSMS, receiverSMS, externalSession = null) {
  let session = externalSession;
  let shouldEndSession = false;
  
  // If no session provided, create our own
  if (!session) {
    session = await mongoose.startSession();
    session.startTransaction();
    shouldEndSession = true;
  }

  try {
    console.log('🤖 Approving matched SMS pair...');
    
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
      description: `Matched deposit via ${userSMS.paymentMethod} (CBE Transfer)`,
      reference: `SMS-MATCHED-${userSMS.metadata?.transactionId || Date.now()}`,
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
    
    await transaction.save({ session });
    await wallet.save({ session });
    await userSMS.save({ session });
    await adminSMS.save({ session });
    
    // Only commit if we created the session
    if (shouldEndSession) {
      await session.commitTransaction();
    }
    
    console.log(`✅ Approved matched deposit: $${amount} for user ${user.telegramId}`);
    
    return {
      transaction,
      wallet,
      userSMS,
      adminSMS,
      autoApproved: true
    };
    
  } catch (error) {
    // Only abort if we created the session
    if (shouldEndSession && session) {
      try {
        await session.abortTransaction();
      } catch (abortError) {
        console.warn('⚠️ Error aborting transaction:', abortError.message);
      }
    }
    
    console.error('❌ Error approving matched SMS:', error);
    throw error;
  } finally {
    // Only end session if we created it
    if (shouldEndSession && session) {
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
static async approveMatchedSMSWithRetry(senderSMS, receiverSMS, externalSession = null) {
  return this.withRetry(() => this.approveMatchedSMS(senderSMS, receiverSMS, externalSession));
}

 static async getUnmatchedSMS() {
    try {
      const unmatchedSMS = await SMSDeposit.find({ 
        status: 'RECEIVED_WAITING_MATCH',
        'metadata.smsType': { $in: ['SENDER', 'RECEIVER'] }
      })
      .populate('userId', 'firstName username telegramId')
      .sort({ createdAt: -1 })
      .limit(50);
      
      // Group by type
      const grouped = {
        SENDER: unmatchedSMS.filter(sms => sms.metadata?.smsType === 'SENDER'),
        RECEIVER: unmatchedSMS.filter(sms => sms.metadata?.smsType === 'RECEIVER')
      };
      
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
  // static extractTransactionIdentifiers(smsText) {
  //   const identifiers = {
  //     amount: this.extractAmountFromSMS(smsText),
  //     transactionId: null,
  //     refNumber: null,
  //     time: null,
  //     senderName: null,
  //     recipientName: null,
  //     accountNumbers: [],
  //     smsBank: this.detectBankFromSMS(smsText)
  //   };
    
  //   // Extract transaction/ref number (FT253422RPRW format)
  //   const refMatch = smsText.match(/Ref No\s*(\w+)/i) || 
  //                    smsText.match(/FT\d+\w+/i) ||
  //                    smsText.match(/Transaction.*?(\w+)/i) ||
  //                    smsText.match(/Txn.*?(\w+)/i);
  //   if (refMatch) {
  //     identifiers.refNumber = refMatch[1];
  //     identifiers.transactionId = refMatch[1];
  //   }
    
  //   // Extract time/date - CBE format: "07/12/2025 at 21:58:15"
  //   const timeMatch = smsText.match(/(\d{2}\/\d{2}\/\d{4})\s*(?:at)?\s*(\d{2}:\d{2}:\d{2})/i);
  //   if (timeMatch) {
  //     identifiers.time = `${timeMatch[1]} ${timeMatch[2]}`;
  //   }
    
  //   // Extract names for CBE format
  //   // "from Defar Gobeze" or "to Defar Gobeze"
  //   const fromMatch = smsText.match(/from\s+([A-Za-z\s]+?)(?:,|\.|on|with|Your)/i);
  //   if (fromMatch) {
  //     identifiers.senderName = fromMatch[1].trim();
  //   }
    
  //   const toMatch = smsText.match(/to\s+([A-Za-z\s]+?)(?:,|\.|on|with|from)/i);
  //   if (toMatch) {
  //     identifiers.recipientName = toMatch[1].trim();
  //   }
    
  //   // Extract masked account numbers (1*****5743)
  //   const accountMatches = smsText.match(/\d\*{5,}\d+/g);
  //   if (accountMatches) {
  //     identifiers.accountNumbers = accountMatches;
  //   }
    
  //   return identifiers;
  // }

  // NEW: Detect bank from SMS
  static detectBankFromSMS(smsText) {
    const sms = smsText.toLowerCase();
    if (sms.includes('cbe')) return 'CBE';
    if (sms.includes('awash')) return 'Awash';
    if (sms.includes('dashen')) return 'Dashen';
    if (sms.includes('telebirr')) return 'Telebirr';
    return 'UNKNOWN';
  }

  // ENHANCED: Try to auto-match SMS with existing ones
 static async tryAutoMatchSMS(newSMSDeposit, smsText) {
  try {
    const newAnalysis = this.analyzeSMSType(smsText);
    const newIdentifiers = this.extractTransactionIdentifiers(smsText);
    
    console.log('🔍 Attempting to match SMS:', newSMSDeposit._id);
    console.log('📊 New SMS type:', newAnalysis.type);
    console.log('📊 New SMS identifiers:', newIdentifiers);
    
    if (!newIdentifiers.amount || newIdentifiers.amount <= 0) {
      console.log('⚠️ No valid amount, cannot match');
      return null;
    }
    
    // Find potential matches based on opposite type
    const oppositeType = newAnalysis.type === 'SENDER' ? 'RECEIVER' : 'SENDER';
    
    const query = {
      _id: { $ne: newSMSDeposit._id },
      status: { 
        $in: ['RECEIVED', 'RECEIVED_WAITING_MATCH', 'PENDING'] 
      },
      smsType: oppositeType, // Use smsType field
      extractedAmount: newIdentifiers.amount,
      createdAt: { 
        $gte: new Date(Date.now() - 60 * 60 * 1000) // Last 1 hour
      }
    };
    
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
        await this.approveMatchedSMS(newSMSDeposit, potentialMatch);
        return potentialMatch;
      }
    }
    
    console.log('❌ No strong matches found');
    
    // If no match found, update status to waiting for match
    newSMSDeposit.status = 'RECEIVED_WAITING_MATCH';
    newSMSDeposit.smsType = newAnalysis.type; // Use smsType field
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
    
    // Fallback: Save with basic status if there's a validation error
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


  // NEW: Detect payment method from SMS content
  static detectPaymentMethodFromSMS(smsText) {
    const sms = smsText.toLowerCase();
    
    if (sms.includes('cbe') && sms.includes('birr')) return 'CBE Birr';
    if (sms.includes('cbe') && !sms.includes('birr')) return 'CBE Bank';
    if (sms.includes('awash')) return 'Awash Bank';
    if (sms.includes('dashen')) return 'Dashen Bank';
    if (sms.includes('telebirr')) return 'Telebirr';
    
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
static async storeSMSMessage(userId, smsText, paymentMethod = 'UNKNOWN') {
  try {
    console.log('💾 Storing SMS message from user:', userId);
    
    const mongoUserId = await this.resolveUserId(userId);
    const user = await User.findById(mongoUserId);
    
    if (!user) {
      throw new Error('User not found');
    }

    const amount = this.extractAmountFromSMS(smsText);
    const detectedMethod = this.detectPaymentMethodFromSMS(smsText);
    const finalMethod = paymentMethod === 'UNKNOWN' ? detectedMethod : paymentMethod;
    
    // Analyze SMS type for matching
    const analysis = this.analyzeSMSType(smsText);
    const identifiers = this.extractTransactionIdentifiers(smsText);
    
    // Clean the reference before storing
    let cleanReference = identifiers.refNumber;
    if (cleanReference) {
      cleanReference = this.cleanCBEReference(cleanReference);
    }
    
    const smsDeposit = new SMSDeposit({
      userId: mongoUserId,
      telegramId: user.telegramId,
      originalSMS: smsText,
      paymentMethod: finalMethod,
      extractedAmount: amount || 0,
      extractedReference: cleanReference || null, // Store CLEAN reference
      status: 'RECEIVED',
      smsType: analysis.type,
      metadata: {
        smsLength: smsText.length,
        hasTransactionId: smsText.includes('Txn ID') || smsText.includes('Transaction'),
        hasBalance: smsText.includes('balance') || smsText.includes('Balance'),
        amountDetected: !!amount,
        detectedAmount: amount,
        storedAt: new Date(),
        autoProcessAttempted: false,
        confidence: analysis.confidence,
        // Store both raw and cleaned references
        transactionIdentifiers: identifiers,
        refNumber: cleanReference,
        rawRefNumber: identifiers.rawRefNumber,
        originalRefNumber: identifiers.refNumber // Store original before cleaning
      }
    });

    await smsDeposit.save();
    console.log('✅ SMS stored successfully:', {
      id: smsDeposit._id,
      type: smsDeposit.smsType,
      amount: smsDeposit.extractedAmount,
      reference: smsDeposit.extractedReference,
      rawReference: identifiers.rawRefNumber
    });

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
        accountNumber: '1000200030004000',
        instructions: 'Send money to CBE account 1000200030004000 via CBE Birr or bank transfer',
        smsFormat: 'You have received|ETB|from|CBE'
      },
      {
        name: 'Awash Bank',
        type: 'BANK', 
        accountName: 'Bingo Game',
        accountNumber: '2000300040005000',
        instructions: 'Send money to Awash Bank account 2000300040005000',
        smsFormat: 'You have received|ETB|from|Awash'
      },
      {
        name: 'Dashen Bank',
        type: 'BANK',
        accountName: 'Bingo Game',
        accountNumber: '3000400050006000',
        instructions: 'Send money to Dashen Bank account 3000400050006000',
        smsFormat: 'You have received|ETB|from|Dashen'
      },
      {
        name: 'CBE Birr',
        type: 'MOBILE_MONEY',
        accountName: 'Bingo Game',
        accountNumber: '0911000000',
        instructions: 'Send money to CBE Birr 0911000000',
        smsFormat: 'You have received|ETB|from|CBEBirr'
      },
      {
        name: 'Telebirr',
        type: 'MOBILE_MONEY',
        accountName: 'Bingo Game',
        accountNumber: '0912000000',
        instructions: 'Send money to Telebirr 0912000000',
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
}

module.exports = WalletService;
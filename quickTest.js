// quickTest.js - Quick SMS Reference Testing
const WalletService = require('./src/services/walletService');

function testReferenceExtraction() {
  const smsMessages = [
    // Test case from your question
    `Dear Defar, You have transfered ETB 50.00 to Defar Gobeze on 07/12/2025 at 21:58:15 from your account 1*****6342. Your account has been debited with a S.charge of ETB 0.50 and  15% VAT of ETB0.08, with a total of ETB50.58. Your Current Balance is ETB 285,823.10. Thank you for Banking with CBE! https://apps.cbe.com.et:100/?id=FT253422RPRW11206342 For feedback click the link https://forms.gle/R1s9nkJ6qZVCxRVu9`,

  ];

  console.log('🧪 Testing SMS Reference Extraction\n');
  
  smsMessages.forEach((sms, index) => {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Test ${index + 1}:`);
    console.log(`SMS Preview: "${sms.substring(0, 80)}..."\n`);
    
    try {
      const identifiers = WalletService.extractTransactionIdentifiers(sms);
      console.log(`✅ Extracted Reference: ${identifiers.refNumber || 'None'}`);
      console.log(`✅ Amount: ${identifiers.amount}`);
      console.log(`✅ Bank: ${identifiers.smsBank}`);
      console.log(`✅ Type: ${identifiers.isCredit ? 'CREDIT' : identifiers.isDebit ? 'DEBIT' : 'UNKNOWN'}`);
      
      if (identifiers.refNumber) {
        const cleaned = WalletService.cleanCBEReference(identifiers.refNumber);
        console.log(`✅ Cleaned Reference: ${cleaned}`);
      }
      
    } catch (error) {
      console.log(`❌ Error: ${error.message}`);
    }
  });
}

// Run the test
testReferenceExtraction();
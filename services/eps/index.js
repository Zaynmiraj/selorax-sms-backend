const crypto = require('crypto');

const EPS_BASE_URL = () => process.env.EPS_BASE_URL || 'https://pgapi.eps.com.bd';

/**
 * Generate HMAC-SHA512 hash for EPS x-hash header.
 * Steps: Encode hashKey as UTF-8, create HMACSHA512, compute with the data, return Base64.
 */
function generateHash(data, hashKey) {
    const key = Buffer.from(hashKey, 'utf8');
    return crypto.createHmac('sha512', key).update(data).digest('base64');
}

/**
 * Get a bearer token from EPS auth endpoint.
 */
async function getToken() {
    const userName = process.env.EPS_USERNAME;
    const password = process.env.EPS_PASSWORD;
    const hashKey = process.env.EPS_HASH_KEY;

    const xHash = generateHash(userName, hashKey);

    const response = await fetch(`${EPS_BASE_URL()}/v1/Auth/GetToken`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-hash': xHash,
        },
        body: JSON.stringify({ userName, password }),
    });

    const data = await response.json();

    if (data.errorCode || data.errorMessage) {
        throw new Error(`EPS GetToken failed: ${data.errorMessage || data.errorCode}`);
    }

    return data.token;
}

/**
 * Initialize an EPS payment session.
 * Returns { transactionId, redirectURL }
 */
async function initializePayment({ merchantTransactionId, amount, successUrl, failUrl, cancelUrl, customerName, customerEmail, customerPhone, store_id }) {
    const token = await getToken();
    const hashKey = process.env.EPS_HASH_KEY;
    const xHash = generateHash(merchantTransactionId, hashKey);

    const body = {
        storeId: process.env.EPS_STORE_ID,
        CustomerOrderId: merchantTransactionId,
        merchantTransactionId,
        transactionTypeId: 1, // Web
        financialEntityId: 0,
        transitionStatusId: 0,
        totalAmount: amount,
        ipAddress: '0.0.0.0',
        version: '1',
        successUrl,
        failUrl,
        cancelUrl,
        customerName: customerName || 'SeloraX Merchant',
        customerEmail: customerEmail || 'merchant@selorax.io',
        CustomerAddress: 'N/A',
        CustomerAddress2: '',
        CustomerCity: 'Dhaka',
        CustomerState: 'Dhaka',
        CustomerPostcode: '1000',
        CustomerCountry: 'BD',
        CustomerPhone: customerPhone || '01700000000',
        ProductName: 'SMS Credits Top-up',
        ProductProfile: 'digital-service',
        ProductCategory: 'SMS Credits',
        NoOfItem: '1',
    };

    const response = await fetch(`${EPS_BASE_URL()}/v1/EPSEngine/InitializeEPS`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-hash': xHash,
            'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(body),
    });

    const data = await response.json();

    if (data.ErrorCode || (data.ErrorMessage && data.ErrorMessage !== '')) {
        throw new Error(`EPS Initialize failed: ${data.ErrorMessage || data.ErrorCode}`);
    }

    return {
        transactionId: data.TransactionId,
        redirectURL: data.RedirectURL,
    };
}

/**
 * Verify an EPS transaction by merchantTransactionId.
 * Returns full transaction details including Status.
 */
async function verifyTransaction(merchantTransactionId) {
    const token = await getToken();
    const hashKey = process.env.EPS_HASH_KEY;
    const xHash = generateHash(merchantTransactionId, hashKey);

    const response = await fetch(
        `${EPS_BASE_URL()}/v1/EPSEngine/CheckMerchantTransactionStatus?merchantTransactionId=${encodeURIComponent(merchantTransactionId)}`,
        {
            method: 'GET',
            headers: {
                'x-hash': xHash,
                'Authorization': `Bearer ${token}`,
            },
        }
    );

    const data = await response.json();
    return data;
}

module.exports = { generateHash, getToken, initializePayment, verifyTransaction };

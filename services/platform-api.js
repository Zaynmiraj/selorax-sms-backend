/**
 * Platform API Client — Shopify-like HTTP communication
 *
 * Authenticates with the SeloraX platform using client_id + client_secret
 * (like Shopify offline access — credentials never expire).
 *
 * Every request sends X-Client-Id, X-Client-Secret, and X-Store-Id headers.
 */

const PLATFORM_API_URL = process.env.SELORAX_API_URL || 'http://localhost:5001/api';
const CLIENT_ID = process.env.SELORAX_CLIENT_ID;
const CLIENT_SECRET = process.env.SELORAX_CLIENT_SECRET;

/**
 * Make an authenticated API call to the SeloraX platform.
 *
 * @param {number} store_id - The store making the request
 * @param {string} method - HTTP method
 * @param {string} path - API path (e.g. '/apps/v1/billing/wallet')
 * @param {object} [body] - Request body for POST/PUT
 * @returns {object} Response data
 */
async function apiCall(store_id, method, path, body = null) {
    if (!CLIENT_ID || !CLIENT_SECRET) {
        throw new Error('SELORAX_CLIENT_ID and SELORAX_CLIENT_SECRET must be set in .env');
    }

    const url = `${PLATFORM_API_URL}${path}`;

    const options = {
        method,
        headers: {
            'Content-Type': 'application/json',
            'X-Client-Id': CLIENT_ID,
            'X-Client-Secret': CLIENT_SECRET,
            'X-Store-Id': String(store_id),
        },
    };

    if (body && (method === 'POST' || method === 'PUT')) {
        options.body = JSON.stringify(body);
    }

    options.signal = AbortSignal.timeout(15000); // 15s timeout
    const response = await fetch(url, options);
    const data = await response.json();

    if (!response.ok) {
        const error = new Error(data.message || `API call failed: ${response.status}`);
        error.status = response.status;
        error.data = data;
        throw error;
    }

    return data;
}

// Convenience methods
const get = (store_id, path) => apiCall(store_id, 'GET', path);
const post = (store_id, path, body) => apiCall(store_id, 'POST', path, body);

module.exports = {
    apiCall,
    get,
    post,
};

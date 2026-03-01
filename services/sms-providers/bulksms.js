/**
 * BulkSMS BD API adapter
 */
class BulkSmsProvider {
    constructor({ endpoint, apiKey, senderId }) {
        this.endpoint = endpoint;
        this.apiKey = apiKey;
        this.senderId = senderId;
    }

    async sendSms(phone, message) {
        try {
            const url = `${this.endpoint}?api_key=${encodeURIComponent(this.apiKey)}&type=text&number=${encodeURIComponent(phone)}&message=${encodeURIComponent(message)}&senderid=${encodeURIComponent(this.senderId)}`;

            const response = await fetch(url);
            const data = await response.json();

            const success = data?.response_code == 202;

            return {
                success,
                provider_response: data,
            };
        } catch (err) {
            return {
                success: false,
                provider_response: { error: err.message },
            };
        }
    }
}

module.exports = BulkSmsProvider;

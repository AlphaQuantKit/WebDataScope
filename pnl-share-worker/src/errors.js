export class RequestValidationError extends Error {
    constructor(message, status = 400, code = 'invalid_request') {
        super(message);
        this.name = 'RequestValidationError';
        this.status = status;
        this.code = code;
    }
}

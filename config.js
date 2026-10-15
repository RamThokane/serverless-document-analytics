
window.APP_CONFIG = Object.freeze({
  apiBaseUrl: "",
  awsRegion: "ap-southeast-2",

  upload: {
    allowedExtensions: [".txt"],
    allowedMimeTypes: ["text/plain", ""],
    contentType: "text/plain",
    maxFileSizeBytes: 1024 * 1024
  },

  polling: {
    intervalMs: 3000,
    maxAttempts: 20
  },

  requestTimeoutMs: 15000
});

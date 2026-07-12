# Deployment Notes

***Important:*** run `npm test` before shipping.

- Check the server health endpoint.
- Confirm the active model is `q8`.
- Review [the voice configuration](https://example.invalid/voice-config).

If the final response includes Markdown, the speech preparation step should remove visual formatting while preserving the useful words.

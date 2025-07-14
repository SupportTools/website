# Cloudflare Workers Logs Guide

Workers Logs are now enabled for all environments. Here's how to access and use them:

## Viewing Logs

### 1. Real-time Logs (Wrangler Tail)

Stream logs in real-time from your terminal:

```bash
# Production logs
wrangler tail --env production

# Development logs  
wrangler tail --env development

# Staging logs
wrangler tail --env staging

# Filter by status code
wrangler tail --env production --status 404

# Filter by method
wrangler tail --env production --method POST

# Filter by IP
wrangler tail --env production --ip 192.168.1.1
```

### 2. Cloudflare Dashboard

1. Log into [Cloudflare Dashboard](https://dash.cloudflare.com)
2. Navigate to Workers & Pages
3. Select your Worker (support-tools)
4. Click on "Logs" tab
5. View real-time and historical logs

### 3. Using the API

Fetch logs programmatically:

```bash
curl -X GET "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/logs/retrieve" \
     -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
     -H "Content-Type: application/json"
```

## Log Format

The Worker logs the following information:

### Request Logs
```
GET /path - client-ip - user-agent
```

### Response Logs  
```
GET /path - status-code - duration-ms - content-length bytes
```

### Error Logs
```
Worker error for /path: error-message stack-trace
```

### Health Check Logs
```
Health check completed in Xms
Version endpoint completed in Xms
```

## Log Retention

- **Free tier**: Real-time logs only (no persistence)
- **Paid plans**: Logs retained based on your plan:
  - Workers Paid: 7 days
  - Enterprise: 30 days

## Debugging Tips

### 1. Monitor 404s
```bash
wrangler tail --env production --status 404
```

### 2. Track Slow Requests
Look for high duration values in logs to identify performance issues.

### 3. Debug Errors
```bash
wrangler tail --env production --status 500
```

### 4. Monitor Specific Paths
```bash
wrangler tail --env production --search "/api"
```

## Performance Monitoring

The logs include request duration, which helps identify:
- Slow endpoints
- Cache misses
- Large file transfers

## Security Monitoring

Monitor for:
- Unusual request patterns
- High error rates
- Suspicious user agents
- Repeated 404s (potential scanning)

## Integration Options

### 1. Log Aggregation
Export logs to external services:
- Datadog
- Splunk
- ElasticSearch
- Custom webhook

### 2. Alerts
Set up alerts in Cloudflare Dashboard for:
- Error rate thresholds
- Traffic spikes
- Performance degradation

## Best Practices

1. **Don't log sensitive data**: Avoid logging tokens, passwords, or PII
2. **Use structured logging**: Consider JSON format for easier parsing
3. **Monitor log volume**: Excessive logging can impact performance
4. **Regular review**: Check logs weekly for anomalies
5. **Set up alerts**: Don't rely on manual log monitoring

## Troubleshooting

### Logs not appearing?
1. Ensure `[observability] enabled = true` in wrangler.toml
2. Redeploy after configuration changes
3. Check API token permissions

### Missing request details?
The Worker only logs what's explicitly coded. Modify `src/worker.js` to log additional fields.

### Performance impact?
Logging adds minimal overhead (~1-2ms per request). For high-traffic sites, consider sampling.
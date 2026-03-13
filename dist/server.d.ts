#!/usr/bin/env node
/**
 * UI Creator MCP Server
 *
 * Enables anyone with Claude Code to build full SaaS apps through chat.
 * Exposes tools for:
 *   - Reading the component manifest (what's available)
 *   - Generating page configs from natural language
 *   - Validating configs against the schema
 *   - Publishing configs to Cloudflare KV (making apps live)
 *   - Managing templates
 *
 * Install: npx @anthropic/ui-creator-mcp
 * Configure: Add to ~/.claude/settings.json under mcpServers
 */
export {};

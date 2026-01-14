# Live Server Investigation Report
**Date:** November 26, 2025  
**Server:** 144.91.93.170  
**Path:** /var/www/infinet.services/ai-studio-backend

## ✅ What's Working

1. **Server is Running**
   - PM2 process: `ai-studio-backend` is online
   - Uptime: 2 days
   - Port: 3002 (correctly configured)
   - Health endpoint responding: ✓

2. **Configuration**
   - All API keys configured (Gemini, OpenAI)
   - Environment variables set correctly
   - Port 3002 matches server.js default

3. **Services Status**
   - Gemini: Configured ✓
   - Gemini Blog: Configured ✓
   - Gemini Social: Configured ✓
   - OpenAI: Configured ✓

---

## ⚠️ CRITICAL ISSUES FOUND

### 1. 🔴 **FREQUENT RESTARTS** (Critical)
**Status:** Process has restarted **24 times** in 2 days

**Evidence:**
```
PM2 Status: ↺ 24 (restart count)
Uptime: 2D
```

**Possible Causes:**
- Memory leaks (Promise.race issue)
- Unhandled errors causing crashes
- Network connectivity issues with Gemini API

**Impact:** 
- Poor user experience
- Potential data loss
- Increased API costs

---

### 2. 🔴 **NETWORK ERRORS WITH GEMINI API** (Critical)
**Status:** Multiple "fetch failed" errors in logs

**Evidence from logs:**
```
AI Chat Error: TypeError: fetch failed
Blog Generation Error: TypeError: fetch failed
Social Content Generation Error: TypeError: fetch failed
Prompt Generation Error: TypeError: fetch failed
```

**Possible Causes:**
- Network connectivity issues
- Firewall blocking outbound requests
- DNS resolution problems
- Gemini API service issues

**Impact:**
- API calls failing
- Users getting errors
- Backend returning 500 errors

---

### 3. ⚠️ **PROMISE.RACE MEMORY LEAK** (High Priority)
**Status:** Confirmed in live code

**Evidence:**
- Code uses `Promise.race()` on lines 107, 209, 269, 375
- When timeout occurs, original promise continues running
- No cancellation mechanism

**Impact:**
- Memory leaks
- Wasted API quota
- Server resource exhaustion
- Likely contributing to frequent restarts

---

### 4. ⚠️ **TIMEOUT ERRORS** (Medium Priority)
**Status:** Multiple timeout errors in logs

**Evidence:**
```
⏱️ Gemini API timeout after 30 seconds
```

**Impact:**
- Users experiencing slow responses
- Requests timing out frequently
- Poor user experience

---

## 📋 Configuration Analysis

### Port Configuration ✅
- **Live Server:** Port 3002 (correct)
- **server.js default:** Port 3002 (matches)
- **.env file:** PORT=3002 (matches)
- **Status:** ✅ No port mismatch issue

### Apache Configuration ✅
- **File exists:** `/etc/apache2/sites-available/ai-studio-backend.conf`
- **Reverse Proxy:** ✅ Configured correctly
- **Proxy URL:** `http://api-ai.infinet.services/api/` → `http://localhost:3002/api/`
- **CORS:** Configured with wildcard (*) - security concern
- **Status:** Apache proxy is working, but frontend might not be using it

### File Permissions
- **server.js:** Owned by user 501 (should be root or www-data)
- **.env:** Owned by root ✓
- **node_modules:** Owned by root ✓

---

## 🔧 Recommended Fixes (Priority Order)

### 1. **URGENT: Fix Network Connectivity**
- Check firewall rules for outbound connections
- Verify DNS resolution
- Test Gemini API connectivity from server
- Check if server can reach `generativelanguage.googleapis.com`

### 2. **URGENT: Fix Promise.race Memory Leak**
- Implement proper cancellation using AbortController
- Or use a timeout library that cancels promises
- This will reduce memory usage and prevent restarts

### 3. **HIGH: Investigate Frequent Restarts**
- Check PM2 logs for crash reasons
- Monitor memory usage over time
- Add better error handling to prevent crashes

### 4. **MEDIUM: Improve Timeout Handling**
- Increase timeout if network is slow
- Add retry logic for failed requests
- Better error messages for users

### 5. **LOW: Fix File Permissions**
- Change server.js owner to root or www-data
- Ensure consistent ownership

---

## 📊 Server Health Metrics

- **Process ID:** 3263478
- **Memory Usage:** 76.8 MB
- **CPU Usage:** 0%
- **Restart Count:** 24 (in 2 days = ~12 restarts/day)
- **Status:** Online but unstable

---

## 🎯 Next Steps

1. ✅ **Immediate:** Check network connectivity to Gemini API
2. ✅ **Immediate:** Fix Promise.race memory leak
3. ✅ **Short-term:** Investigate restart causes
4. ✅ **Short-term:** Add better error handling
5. ✅ **Long-term:** Implement monitoring and alerting

---

## 📝 Notes

- The backend is functional but unstable
- Network errors suggest infrastructure issue
- Memory leaks likely contributing to crashes
- All API keys are configured correctly
- Health endpoint works correctly


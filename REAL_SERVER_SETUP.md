# Production Deployment Blueprint: Real Server Setup (Puppet Mode)

This document provides a step-by-step guide to deploying and running the YouTube Pipeline project on a remote server 24/7. It is configured for **Automated Browser (Puppet Mode) only**, bypassing the YouTube Data API v3 entirely to avoid quota restrictions.

---

## 1. Recommended Server Specifications

* **Operating System**: **Windows Server 2019 or 2022** (Standard Edition)
  * *Why?* Windows Server provides a native Remote Desktop (RDP) GUI interface out-of-the-box. This is the simplest way to perform the manual one-time Google Account login step for your 50 channels.
* **Hardware Specs**:
  * **vCPU**: 4 Cores (handles background browser processing easily)
  * **RAM**: 8GB RAM minimum (Puppeteer launches Chrome instances which consume RAM; tasks are run sequentially to conserve memory)
  * **SSD Storage**: 100GB to 500GB+ SSD (based on the size and volume of videos you keep uploaded on the server before they are pushed to YouTube)
* **Providers**: Contabo, Hetzner, AWS, digitalOcean, or Vultr.

---

## 2. Server Initial Configuration

Once your Windows Server VPS is ready:
1. Connect to the server using **Remote Desktop Connection (RDP)** on your computer.
2. Install **Node.js LTS** (v18 or v20) from the official website.
3. Install the standard **Google Chrome** browser (Stable Version).
4. Download or copy your `youtube-pipeline` project files onto the server (e.g., place them in `C:\youtube-pipeline`).
5. Open **Command Prompt** (cmd) or **PowerShell**, navigate to the directory, and install dependencies:
   ```cmd
   cd C:\youtube-pipeline
   npm install
   ```

---

## 3. Environment Configuration (`.env`)

Create a `.env` file in the root folder (`C:\youtube-pipeline\.env`) with the following settings. Note that **no Google/YouTube API keys are needed**:

```env
PORT=3000
SESSION_SECRET=choose_a_long_random_secure_string_here

# AI metadata generation keys (optional, for Title/Desc automation)
GEMINI_API_KEY=your_gemini_api_key_here
OPENAI_API_KEY=your_openai_api_key_here
```

---

## 4. Run the Application 24/7 using PM2

To ensure the Node.js server stays online permanently, restarts automatically on errors, and boots up if the server restarts:
1. Install **PM2** globally:
   ```cmd
   npm install pm2 -g
   ```
2. Start the server using PM2:
   ```cmd
   pm2 start server/index.js --name "youtube-pipeline"
   ```
3. Save the PM2 process list:
   ```cmd
   pm2 save
   ```
4. Set up PM2 to auto-start on Windows boot (optional, requires `pm2-windows-service` or a Windows Task Scheduler task running the command `pm2 resurrect`).

---

## 5. Connecting YouTube Channels (Manual Login Flow)

For each of your channels, follow these steps **directly from the Windows Server Remote Desktop window**:

1. Open your server's web browser and navigate to the dashboard at `http://localhost:3000` (or your public server link).
2. Go to the **Channels** tab and click **＋ Add Channel**.
3. Set the **Upload Mode** to **Automated Browser (Puppet Mode)**.
4. Click **Save Channel**.
5. Find the channel in your list and click **Edit** (pencil icon).
6. Under the connection options, click **Start Browser Login**.
7. **Watch the server desktop**: A new Chrome window controlled by Puppeteer will pop up.
8. Log in manually to your Google Account associated with the YouTube channel, perform any 2FA verification, and wait until the YouTube Studio dashboard loads.
9. Close the popped-up Chrome window.
10. **Done**: Puppeteer has saved the login session inside `data/profiles/channel_<id>`. You will never need to log in again unless Google revokes the session.

---

## 6. Accessing the Dashboard Remotely (Nginx & SSL Setup)

To access your panel securely from your personal laptop (or share access with your friend) over HTTPS:
1. Point a domain (e.g., `panel.yourdomain.com`) to your server's public IP address.
2. Install **Nginx for Windows** or **Caddy Server**.
3. Configure Nginx to proxy traffic from port 80/443 to port 3000:
   ```nginx
   server {
       listen 80;
       server_name panel.yourdomain.com;
       location / {
           proxy_pass http://127.0.0.1:3000;
           proxy_http_version 1.1;
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection 'upgrade';
           proxy_set_header Host $host;
           proxy_cache_bypass $http_upgrade;
       }
   }
   ```
4. Install a free SSL certificate using **Win-ACME** or Caddy Server (which handles SSL automatically).

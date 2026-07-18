@echo off
REM Secure local tunnel for keeper health and owner-signed rule settings. No VM firewall port is opened.
"C:\Users\Vibe Code\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd" compute ssh ubuntu@instance-20260716-095859 --zone us-central1-c --project project-28742528-d617-4e14-b18 --quiet -- -N -L 8787:127.0.0.1:8787

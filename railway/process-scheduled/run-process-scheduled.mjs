const endpoint = process.env.PROCESS_SCHEDULED_URL;
const cronSecret = process.env.CRON_SECRET;

if (!endpoint) {
  console.error("PROCESS_SCHEDULED_URL is required");
  process.exit(1);
}

if (!cronSecret) {
  console.error("CRON_SECRET is required");
  process.exit(1);
}

const response = await fetch(endpoint, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Cron-Secret": cronSecret,
  },
  body: "{}",
});

const responseBody = await response.text();

if (!response.ok) {
  console.error(`process-scheduled failed with status ${response.status}`);
  if (responseBody) {
    console.error(responseBody);
  }
  process.exit(1);
}

if (responseBody) {
  console.log(responseBody);
} else {
  console.log("process-scheduled completed successfully");
}

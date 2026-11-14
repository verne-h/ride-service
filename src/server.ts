import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { loadDrivers } from "./resources/drivers/repository.js";

const [config, dataset] = await Promise.all([loadConfig(), loadDrivers()]);
console.info(`Loaded ${dataset.drivers.length} drivers; excluded ${dataset.excludedRecords.length} invalid or duplicate records`);

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be an integer from 1 to 65535");
createApp(dataset, config).listen(port, () => {
  console.info(`Ride dispatch API listening on port ${port}`);
});

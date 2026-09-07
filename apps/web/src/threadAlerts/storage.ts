export {
  claimAlertDelivery,
  releaseAlertLease,
  saveAlertSound,
  readAlertSound,
  deleteAlertSound,
} from "@spiritdevs/client-runtime/thread-alerts/storage";
import { updateAlertPresence as updatePresence } from "@spiritdevs/client-runtime/thread-alerts/storage";

export const updateAlertPresence = (userId: string, tabId: string, threadKey: string | null) =>
  updatePresence(userId, tabId, threadKey, Date.now());

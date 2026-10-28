import { registerDeliveryAction } from '../../delivery.js';
import { handleScheduleTask, handleUpdateTask } from './actions.js';

const actions = { schedule_task: handleScheduleTask, update_task: handleUpdateTask };
for (const [action, handler] of Object.entries(actions)) registerDeliveryAction(action, handler);

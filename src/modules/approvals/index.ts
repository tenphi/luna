import { onDeliveryAdapterReady } from '../../delivery.js';
import { onShutdown, registerResponseHandler } from '../../response-registry.js';
import { handleApprovalsResponse } from './response-handler.js';
import { startOneCLIApprovalHandler, stopOneCLIApprovalHandler } from './onecli-approvals.js';

export { requestApproval, registerApprovalHandler, registerDeclineHandler, notifyAgent } from './primitive.js';
export type {
  ApprovalHandler,
  ApprovalHandlerContext,
  DeclineHandler,
  DeclineHandlerContext,
  RequestApprovalOptions,
} from './primitive.js';

registerResponseHandler(handleApprovalsResponse);
onDeliveryAdapterReady(startOneCLIApprovalHandler);
onShutdown(stopOneCLIApprovalHandler);

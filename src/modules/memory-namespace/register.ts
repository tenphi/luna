import { registerApprovalHandler } from '../approvals/index.js';
import { applyNamespaceApproval, MEMORY_NAMESPACE_ACTION } from './index.js';

registerApprovalHandler(MEMORY_NAMESPACE_ACTION, applyNamespaceApproval);

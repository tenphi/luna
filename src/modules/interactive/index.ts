import { randomUUID } from 'node:crypto';
import { deletePendingQuestion, getPendingQuestion, getSession } from '../../db/sessions.js';
import { wakeContainer } from '../../container-runner.js';
import { registerResponseHandler } from '../../response-registry.js';
import { writeSessionMessage } from '../../session-manager.js';

registerResponseHandler(async (answer) => {
  const question = getPendingQuestion(answer.questionId);
  if (!question) return false;
  const session = getSession(question.session_id);
  if (session) {
    writeSessionMessage(session.agent_group_id, session.id, {
      id: `qr-${randomUUID()}`,
      kind: 'system',
      timestamp: new Date().toISOString(),
      platformId: question.platform_id,
      channelType: question.channel_type,
      threadId: question.thread_id,
      content: JSON.stringify({
        type: 'question_response',
        questionId: answer.questionId,
        selectedOption: answer.value,
        userId: answer.userId ?? '',
      }),
    });
  }
  deletePendingQuestion(answer.questionId);
  if (session) await wakeContainer(session);
  return true;
});

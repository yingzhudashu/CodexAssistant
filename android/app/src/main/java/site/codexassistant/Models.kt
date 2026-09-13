package site.codexassistant

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

const val PROTOCOL_VERSION = "codex-assistant.v3"

// 这些模型与 packages/protocol 的 codex-assistant.v3 一一对应，未知字段由 Json 严格拒绝。
@Serializable data class TaskGoal(val objective: String, val status: String, val timeUsedSeconds: Int, val tokensUsed: Int, val tokenBudget: Int? = null)
@Serializable data class PlanStep(val id: String, val title: String, val status: String)
@Serializable data class TaskError(val code: String, val message: String)
@Serializable data class LatestTurn(val status: String, val startedAt: String? = null, val completedAt: String? = null, val durationMs: Int? = null, val error: TaskError? = null)
@Serializable data class TaskSnapshot(val id: String, val title: String, val projectName: String? = null, val status: String, val runtimeStatus: String, val activeFlags: List<String> = emptyList(), val freshness: String, val source: String, val goal: TaskGoal? = null, val latestTurn: LatestTurn? = null, val error: TaskError? = null, val plan: List<PlanStep> = emptyList(), val currentStepId: String? = null, val action: String? = null, val updatedAt: String, val changedAt: String) { init { require(status in setOf("running", "completed", "failed", "needs_action")) { "未知任务状态" } } }
@Serializable data class TraceContext(val traceId: String, val spanId: String, val parentSpanId: String? = null)
@Serializable data class TraceSpan(val traceId: String, val spanId: String, val parentSpanId: String? = null, val name: String, val startedAt: String, val endedAt: String, val attributes: Map<String, String>? = null)
@Serializable data class TraceSpanBatch(val protocolVersion: String = PROTOCOL_VERSION, val spans: List<TraceSpan>)
@Serializable data class ServerEvent(val sequence: Long, val deviceId: String, val localSequence: Long, val occurredAt: String, val trace: TraceContext, val task: TaskSnapshot)
@Serializable data class AuthenticatedMessage(val type: String, val protocolVersion: String)
@Serializable data class EventMessage(val type: String, val protocolVersion: String, val event: ServerEvent)
@Serializable data class SnapshotMessage(val type: String, val protocolVersion: String, val cursor: Long, val tasks: List<TaskSnapshot>)
@Serializable data class ErrorMessage(val type: String, val protocolVersion: String, val code: String, val message: String)
@Serializable data class ClientAuthMessage(val type: String = "auth", val protocolVersion: String = PROTOCOL_VERSION, val token: String)
@Serializable data class ClientSubscribeMessage(val type: String = "subscribe", val protocolVersion: String = PROTOCOL_VERSION, val after: Long)
@Serializable data class ClientDetailMessage(val type: String = "detail", val protocolVersion: String = PROTOCOL_VERSION, val requestId: String, val threadId: String, val cursor: String? = null, val limit: Int? = 20)
@Serializable data class ClientSendMessage(val type: String = "send", val protocolVersion: String = PROTOCOL_VERSION, val requestId: String, val threadId: String, val text: String)
@Serializable data class InteractionSubmit(val type: String = "interaction.submit", val protocolVersion: String = PROTOCOL_VERSION, val requestId: String, val threadId: String, val value: JsonElement)
@Serializable data class DetailMessage(val type: String, val protocolVersion: String, val requestId: String, val threadId: String, val turns: List<JsonElement> = emptyList(), val cursor: String? = null)
@Serializable data class ResultMessage(val type: String, val protocolVersion: String, val requestId: String, val threadId: String, val status: String, val error: String? = null) { init { require(status in setOf("started", "failed")) { "未知发送回执状态" } } }
@Serializable data class InteractionOption(val id: String, val label: String, val description: String? = null)
@Serializable data class InteractionQuestion(val id: String, val header: String, val question: String, val required: Boolean, val multiple: Boolean, val isSecret: Boolean? = null, val isOther: Boolean? = null, val options: List<InteractionOption> = emptyList())
@Serializable data class InteractionRequest(val type: String, val protocolVersion: String, val requestId: String, val threadId: String, val kind: String, val title: String, val description: String? = null, val options: List<InteractionOption> = emptyList(), val questions: List<InteractionQuestion> = emptyList(), val expiresAt: String? = null)
@Serializable data class InteractionResult(val type: String, val protocolVersion: String, val requestId: String, val threadId: String, val status: String, val value: JsonElement? = null, val error: String? = null)

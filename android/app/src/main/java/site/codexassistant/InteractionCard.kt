package site.codexassistant

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import kotlinx.serialization.json.*

fun interactionAnswers(
    questions: List<InteractionQuestion>,
    answers: Map<String, List<String>>,
): JsonObject = buildJsonObject {
    put(
        "answers",
        buildJsonObject {
            questions.forEach { q ->
                answers[q.id]?.let { values ->
                    put(
                        q.id,
                        buildJsonObject { put("answers", JsonArray(values.map(::JsonPrimitive))) },
                    )
                }
            }
        },
    )
}

@Composable
fun InteractionCard(
    request: InteractionRequest,
    connected: Boolean,
    submitting: Boolean,
    error: String?,
    submit: (JsonElement) -> Unit,
) {
    // 回答（含秘密字段）只驻留内存，不能进入可保存页面状态。
    var answers by
        remember(request.requestId) { mutableStateOf<Map<String, List<String>>>(emptyMap()) }
    var other by remember(request.requestId) { mutableStateOf<Set<String>>(emptySet()) }
    val enabled = connected && !submitting
    OutlinedCard(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(
                "待确认",
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.primary,
            )
            Text(request.title, style = MaterialTheme.typography.titleLarge)
            request.description?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
            error
                ?.takeUnless { submitting }
                ?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            if (!connected) Text("连接断开，回答暂存于当前页面；恢复后可提交。")
            if (submitting) {
                LinearProgressIndicator(Modifier.fillMaxWidth())
                Text("正在等待工作站确认…")
            }
            when (request.kind) {
                "confirm" ->
                    request.options.forEach { option ->
                        OutlinedButton(
                            { submit(buildJsonObject { put("decision", option.id) }) },
                            enabled = enabled,
                            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                        ) {
                            Text(option.label)
                        }
                        option.description?.let {
                            Text(it, style = MaterialTheme.typography.bodySmall)
                        }
                    }
                "single_select",
                "multi_select",
                "text",
                "plan_select" -> {
                    request.questions.forEach { question ->
                        HorizontalDivider()
                        Text(
                            question.header + if (question.required) " · 必填" else " · 可选",
                            style = MaterialTheme.typography.titleMedium,
                        )
                        Text(question.question)
                        if (question.multiple)
                            Text("可选择多项", style = MaterialTheme.typography.bodySmall)
                        question.options.forEach { option ->
                            val selected =
                                answers[question.id].orEmpty().contains(option.label) &&
                                    question.id !in other
                            FilterChip(
                                selected = selected,
                                enabled = enabled,
                                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                                onClick = {
                                    other = other - question.id
                                    val current = answers[question.id].orEmpty()
                                    answers =
                                        answers +
                                            (question.id to
                                                if (question.multiple) {
                                                    if (selected) current - option.label
                                                    else current + option.label
                                                } else listOf(option.label))
                                },
                                label = { Text(option.label) },
                            )
                            option.description?.let {
                                Text(
                                    it,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                        if (question.options.isNotEmpty() && question.isOther == true)
                            TextButton(
                                {
                                    other = other + question.id
                                    answers = answers - question.id
                                },
                                enabled = enabled,
                            ) {
                                Text("填写其他回答")
                            }
                        if (question.options.isEmpty() || question.id in other)
                            OutlinedTextField(
                                value = answers[question.id]?.firstOrNull().orEmpty(),
                                onValueChange = {
                                    if (it.length <= 20000)
                                        answers = answers + (question.id to listOf(it))
                                },
                                modifier = Modifier.fillMaxWidth(),
                                enabled = enabled,
                                label = { Text(question.header) },
                                visualTransformation =
                                    if (question.isSecret == true) PasswordVisualTransformation()
                                    else VisualTransformation.None,
                            )
                    }
                    Button(
                        { submit(interactionAnswers(request.questions, answers)) },
                        enabled =
                            enabled &&
                                request.questions.all {
                                    !it.required || answers[it.id]?.any(String::isNotBlank) == true
                                },
                        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                    ) {
                        Text("提交全部回答")
                    }
                }
                else -> Text("此请求无法在当前客户端处理。可取消后在工作站重新发起。")
            }
            TextButton(
                { submit(buildJsonObject { put("cancel", true) }) },
                enabled = enabled,
                modifier = Modifier.heightIn(min = 48.dp),
            ) {
                Text("取消请求")
            }
        }
    }
}

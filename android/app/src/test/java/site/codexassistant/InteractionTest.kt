package site.codexassistant

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class InteractionTest {
    @Test
    fun completeFormPreservesQuestionIdsAndMultipleAnswers() {
        val fields =
            listOf(
                InteractionQuestion("plan", "Plan", "Select", true, false),
                InteractionQuestion("features", "Features", "Select several", true, true),
            )
        val wire =
            interactionAnswers(
                fields,
                mapOf("plan" to listOf("Implement"), "features" to listOf("A", "B")),
            )
        assertEquals(
            listOf("A", "B"),
            wire["answers"]!!.jsonObject["features"]!!.jsonObject["answers"]!!.jsonArray.map {
                it.jsonPrimitive.content
            },
        )
        assertEquals(
            "Implement",
            wire["answers"]!!
                .jsonObject["plan"]!!
                .jsonObject["answers"]!!
                .jsonArray
                .single()
                .jsonPrimitive
                .content,
        )
    }

    @Test
    fun officialInputFormDecodesSecretAndOtherFlags() {
        val wire =
            """{"type":"interaction.request","protocolVersion":"codex-assistant.v3","requestId":"request","threadId":"thread","kind":"text","title":"Question","questions":[{"id":"secret","header":"Secret","question":"Enter","required":true,"multiple":false,"isSecret":true,"isOther":true}]}"""
        val request = wireJson.decodeFromString<InteractionRequest>(wire)
        assertTrue(request.questions.single().isSecret == true)
        assertTrue(request.questions.single().isOther == true)
        assertTrue(request.questions.single().options.isEmpty())
    }
}

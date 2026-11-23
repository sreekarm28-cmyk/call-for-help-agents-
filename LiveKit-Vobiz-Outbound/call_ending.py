"""Configure the voice SDK's goodbye and SIP disconnection tool."""

from livekit.agents.beta import EndCallTool


def booking_end_call_tool() -> EndCallTool:
    return EndCallTool(
        delete_room=True,
        extra_description=(
            "For this offer-collection call, also end when the provider has confirmed "
            "the fees and visit timing, or declined the work. Do not wait for a goodbye. "
            "If missing details remain unavailable after one clarification and there "
            "is nothing else to discuss, end with those details unknown. "
            "Never end while the person is asking a question, correcting details, or asking to wait."
        ),
        end_instructions=(
            "Say only one short, natural goodbye in the conversation's current language. "
            "Thank them and say you will share the information with the customer. "
            "Do not repeat prices or the job description, ask another question, "
            "or claim the booking is confirmed."
        ),
    )

using Colyseus.Schema;
#if UNITY_5_3_OR_NEWER
using UnityEngine.Scripting;
#endif

namespace MonkeyPunch.Wire {

public partial class ItemState : Schema {
#if UNITY_5_3_OR_NEWER
[Preserve]
#endif
public ItemState() { }
	[Type(0, "uint8")]
	public byte kind = default(byte);

	[Type(1, "uint8")]
	public byte level = default(byte);
}

}

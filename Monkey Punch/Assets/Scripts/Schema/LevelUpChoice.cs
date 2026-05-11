using Colyseus.Schema;
#if UNITY_5_3_OR_NEWER
using UnityEngine.Scripting;
#endif

namespace MonkeyPunch.Wire {

public partial class LevelUpChoice : Schema {
#if UNITY_5_3_OR_NEWER
[Preserve]
#endif
public LevelUpChoice() { }
	[Type(0, "uint8")]
	public byte type = default(byte);

	[Type(1, "uint8")]
	public byte index = default(byte);
}

}

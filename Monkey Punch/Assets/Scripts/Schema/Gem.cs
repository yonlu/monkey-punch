using Colyseus.Schema;
#if UNITY_5_3_OR_NEWER
using UnityEngine.Scripting;
#endif

namespace MonkeyPunch.Wire {

public partial class Gem : Schema {
#if UNITY_5_3_OR_NEWER
[Preserve]
#endif
public Gem() { }
	[Type(0, "uint32")]
	public uint id = default(uint);

	[Type(1, "number")]
	public float x = default(float);

	[Type(2, "number")]
	public float z = default(float);

	[Type(3, "uint16")]
	public ushort value = default(ushort);
}

}

// ===== Constants & Styles =====
const SNAP_STEP = 1;
const LABEL_SIZE = 0.2;
const LABEL_OFFSET = 0.5;
const HUMAN_HEIGHT = 1.75; // meters (5'9")
const BOX_COLORS = { hover:0x99ccff, selected:0x0000ff, editing:0xffffff };

// ===== Scene setup =====
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x202020);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth/window.innerHeight, 0.1, 1000);
camera.position.set(3,3,6);

const renderer = new THREE.WebGLRenderer({ antialias:true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
document.body.appendChild(renderer.domElement);

const orbit = new THREE.OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;

let groundSize = 20;
orbit.minDistance = 1;
orbit.maxDistance = groundSize * 1.5;

const transform = new THREE.TransformControls(camera, renderer.domElement);
transform.setSpace('local'); // Use local space for better rotation behavior
transform.setSize(0.8); // Slightly smaller gizmo for better visibility
scene.add(transform);

let selectedObject = null;
let selectedObjects = [];
let hoveredObject = null;
let draggedItem = null;
let draggedObject = null;
let draggedObjects = []; // Array to hold multiple dragged objects
let isAltPressed = false;
let isDuplicating = false;
let originalObject = null;

scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.2));
const dirLight = new THREE.DirectionalLight(0xffffff, 1);
dirLight.position.set(5,10,7);
scene.add(dirLight);

let grid = new THREE.GridHelper(groundSize, groundSize, 0x888888, 0x444444);
grid.userData.isSelectable = false;
grid.raycast = () => {};
scene.add(grid);

let ruler = null;
let humanGuide = null;

// Human guide (reference only)
humanGuide = createHumanGuide(HUMAN_HEIGHT);
scene.add(humanGuide);


// ===== UI refs =====
const loader = new THREE.GLTFLoader();
const fileInput = document.getElementById("file");
const modelList = document.getElementById("modelList");
const propertiesPanel = document.getElementById("properties");
const snapCheckbox = document.getElementById("snap");
const canvasSizeInput = document.getElementById("canvasSize");
const btnTranslate = document.getElementById("translate");
const btnRotate = document.getElementById("rotate");
const btnScale = document.getElementById("scale");
const btnDelete = document.getElementById("delete");
const btnUndo = document.getElementById("undo");
const btnResetCamera = document.getElementById("resetCamera");

let modelCounter = 1;

let loadedFont = null;
const fontLoader = new THREE.FontLoader();
fontLoader.load('https://threejs.org/examples/fonts/helvetiker_regular.typeface.json', font => {
  loadedFont = font;
  ruler = createRuler(groundSize, 1);
  addRulerLabels(ruler, groundSize, 1, loadedFont);
  ruler.userData.isSelectable = false;
  scene.add(ruler);
});

// ===== Utilities =====
function getBox(obj){ return new THREE.Box3().setFromObject(obj); }

function updateAllVisuals(obj){
  if(!obj) return;

  // Apply canvas clamp restrictions to any object being transformed (including nested objects)
  clampToCanvasRecursive(obj);

  updateModelProperties(obj);
  updatePropertiesPanel(obj);
  updateBoxHelper(obj);

  // If this is a group, also update child bounding boxes
  if (obj.userData?.isEditorGroup) {
    updateChildBoundingBoxes(obj);
  }

  // If this object is a child in a group, update the parent group's bounding box
  if (isChildObjectInGroup(obj) && obj.parent) {
    updateParentGroupBounds(obj.parent);
  }

  // Only add dimension labels for selected objects
  if(selectedObjects.includes(obj)) {
    addBoundingBoxDimensions(obj);
  }
}

function updateParentGroupBounds(parentGroup) {
  if (!parentGroup || !parentGroup.userData?.isEditorGroup) return;

  // Update the parent group's box helper
  if (parentGroup.userData.boxHelper) {
    parentGroup.userData.boxHelper.update();
  }

  // Update the parent group's parent box helper (gray one)
  if (parentGroup.userData.parentBoxHelper) {
    parentGroup.userData.parentBoxHelper.update();
  }

  // Recursively update parent groups if this group is nested
  if (isChildObjectInGroup(parentGroup) && parentGroup.parent) {
    updateParentGroupBounds(parentGroup.parent);
  }
}

function cleanupObject(obj){
  if (!obj) return;
  if (obj.userData.boxHelper) {
    scene.remove(obj.userData.boxHelper);
    obj.userData.boxHelper.geometry?.dispose();
    obj.userData.boxHelper.material?.dispose();
    delete obj.userData.boxHelper;
  }
  if (obj.userData.parentBoxHelper) {
    scene.remove(obj.userData.parentBoxHelper);
    obj.userData.parentBoxHelper.geometry?.dispose();
    obj.userData.parentBoxHelper.material?.dispose();
    delete obj.userData.parentBoxHelper;
  }
  if (obj.userData.dimGroup) {
    scene.remove(obj.userData.dimGroup);
    obj.userData.dimGroup.traverse(c=>{
      c.geometry?.dispose();
      c.material?.dispose();
    });
    delete obj.userData.dimGroup;
  }
  if (obj.userData.listItem) {
    const li = obj.userData.listItem;
    const next = li.nextSibling;
    li.remove();
    if (next && next.tagName === "UL") next.remove();
    delete obj.userData.listItem;
  }
}

function snapUniformScale(obj, step=SNAP_STEP){
  const box = getBox(obj);
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  const snapped = Math.max(step, Math.round(maxDim/step)*step);
  if (maxDim > 0) obj.scale.multiplyScalar(snapped/maxDim);
}

function clampToCanvas(obj){
  const half = groundSize/2;
  const box = getBox(obj);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const minX = center.x - size.x/2, maxX = center.x + size.x/2;
  const minZ = center.z - size.z/2, maxZ = center.z + size.z/2;
  if (minX < -half) obj.position.x += -half - minX;
  if (maxX >  half) obj.position.x -= maxX - half;
  if (minZ < -half) obj.position.z += -half - minZ;
  if (maxZ >  half) obj.position.z -= maxZ - half;
  if (box.min.y < 0) obj.position.y += -box.min.y;
}

function clampToCanvasRecursive(obj){
  // Only clamp top-level groups as single units
  // Nested groups should move with their parent group, not be individually clamped
  if (obj.userData?.isEditorGroup) {
    // Only clamp the group as a whole unit
    // Do NOT recursively clamp nested groups - they should move with the parent
    clampToCanvas(obj);
  } else {
    // For non-groups, clamp normally
    clampToCanvas(obj);
  }
}

function findTopLevelGroup(obj) {
  // Find the top-level group in the hierarchy (the one directly attached to scene)
  let current = obj;
  while (current.parent && current.parent !== scene && current.parent.userData?.isEditorGroup) {
    current = current.parent;
  }
  return current;
}

function updateModelProperties(model){
  if(!model) return;
  const box = getBox(model);
  const size = box.getSize(new THREE.Vector3());

  // Get world position for accurate meter measurements
  const worldPosition = new THREE.Vector3();
  model.getWorldPosition(worldPosition);

  // Get world scale
  const worldScale = new THREE.Vector3();
  model.getWorldScale(worldScale);

  model.userData.properties = {
    pos: worldPosition,
    scl: worldScale,
    size: size.clone()
  };
}

function updatePropertiesPanel(model){
  if(!model || !model.userData.properties){
    propertiesPanel.textContent = "";
    return;
  }
  const p = model.userData.properties;
  propertiesPanel.textContent =
    `Position: (${p.pos.x.toFixed(2)}, ${p.pos.y.toFixed(2)}, ${p.pos.z.toFixed(2)})\n`+
    `Scale: (${p.scl.x.toFixed(2)}, ${p.scl.y.toFixed(2)}, ${p.scl.z.toFixed(2)})\n`+
    `Bounds: (${p.size.x.toFixed(2)}, ${p.size.y.toFixed(2)}, ${p.size.z.toFixed(2)})`;
}

function updateTransformButtonStates(){
  const editingAllowed = isEditingAllowed();
  const buttons = [btnTranslate, btnRotate, btnScale];

  buttons.forEach(btn => {
    if (editingAllowed) {
      btn.disabled = false;
      btn.style.opacity = "1";
      btn.style.cursor = "pointer";
    } else {
      btn.disabled = true;
      btn.style.opacity = "0.5";
      btn.style.cursor = "not-allowed";
    }
  });

  // Detach transform gizmo if editing is not allowed
  if (!editingAllowed) {
    transform.detach();
  } else if (selectedObject) {
    // Reattach to the selected object if editing is allowed
    transform.attach(selectedObject);
  }
}

function createBoxHelperFor(model){
  const helper = new THREE.BoxHelper(model, BOX_COLORS.selected);
  helper.material.transparent = true;
  helper.material.opacity = 0.9;
  helper.visible = false;
  model.userData.boxHelper = helper;
  scene.add(helper);
}

function updateBoxHelper(model, color=null){
  if (!model?.userData.boxHelper) return;
  model.userData.boxHelper.update();
  if (color) model.userData.boxHelper.material.color.setHex(color);
}

function setHelperVisible(model, visible){
  if(model?.userData.boxHelper) model.userData.boxHelper.visible = !!visible;
}

function createParentBoxHelperFor(parentGroup){
  if (!parentGroup || parentGroup.userData.parentBoxHelper) return;
  const helper = new THREE.BoxHelper(parentGroup, 0x888888); // Gray color for parent
  helper.material.transparent = true;
  helper.material.opacity = 0.5;
  helper.visible = false;
  parentGroup.userData.parentBoxHelper = helper;
  scene.add(helper);
}

function updateParentBoxHelper(parentGroup, color=null){
  if (!parentGroup?.userData.parentBoxHelper) return;
  parentGroup.userData.parentBoxHelper.update();
  if (color) parentGroup.userData.parentBoxHelper.material.color.setHex(color);
}

function setParentHelperVisible(parentGroup, visible){
  if(parentGroup?.userData.parentBoxHelper) parentGroup.userData.parentBoxHelper.visible = !!visible;
}

function showChildBoundingBoxes(group, visible, color = 0x888888, recursive = true){
  if (!group || !group.userData?.isEditorGroup) return;

  group.children.forEach(child => {
    // Ensure child has a box helper
    if (!child.userData.boxHelper) {
      createBoxHelperFor(child);
    }

    if (visible) {
      child.userData.boxHelper.visible = true;
      child.userData.boxHelper.material.color.setHex(color);
      child.userData.boxHelper.material.opacity = 0.5; // Semi-transparent for child boxes
    } else {
      child.userData.boxHelper.visible = false;
    }

    // Recursively handle nested groups
    if (recursive && child.userData?.isEditorGroup) {
      showChildBoundingBoxes(child, visible, color, recursive);
    }
  });
}

function updateChildBoundingBoxes(group, recursive = true){
  if (!group || !group.userData?.isEditorGroup) return;

  group.children.forEach(child => {
    if (child.userData.boxHelper) {
      child.userData.boxHelper.update();
    }

    // Recursively handle nested groups
    if (recursive && child.userData?.isEditorGroup) {
      updateChildBoundingBoxes(child, recursive);
    }
  });
}

function addBoundingBoxDimensions(model){
  if(!loadedFont) return;
  if(model.userData.dimGroup){
    scene.remove(model.userData.dimGroup);
    model.userData.dimGroup.traverse(c=>{
      c.geometry?.dispose();
      c.material?.dispose();
    });
  }
  const box = getBox(model);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const group = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({color:0xffff00});
  const label = (text,pos)=>{
    const mesh = new THREE.Mesh(
      new THREE.TextGeometry(text,{font:loadedFont,size:LABEL_SIZE,height:0}),
      mat
    );
    mesh.position.copy(pos);
    group.add(mesh);
  };
  label(`${size.x.toFixed(2)}m`, new THREE.Vector3(center.x, box.max.y+0.2, box.min.z-LABEL_OFFSET));
  label(`${size.y.toFixed(2)}m`, new THREE.Vector3(box.max.x+LABEL_OFFSET, center.y, box.min.z-LABEL_OFFSET));
  label(`${size.z.toFixed(2)}m`, new THREE.Vector3(center.x, box.min.y-LABEL_OFFSET, box.max.z+LABEL_OFFSET));
  scene.add(group);
  model.userData.dimGroup = group;
}


// ===== Transforms: initial & helpers =====
function storeInitialTransform(obj){
  obj.userData.initialTransform = {
    pos: obj.position.clone(),
    rot: obj.quaternion.clone(),
    scale: obj.scale.clone()
  };
}

function resetTransform(obj){
  if(!obj.userData.initialTransform) return;
  const t = obj.userData.initialTransform;
  obj.position.copy(t.pos);
  obj.quaternion.copy(t.rot);
  obj.scale.copy(t.scale);
  updateAllVisuals(obj);
}

function dropToFloor(obj){
  const box = new THREE.Box3().setFromObject(obj);
  if (box.isEmpty()) return;
  obj.position.y -= box.min.y;
  updateAllVisuals(obj);
}

// ===== Selection validation helpers =====
function isEditingAllowed(){
  // No editing if no objects selected
  if (selectedObjects.length === 0) return false;

  // Single object selected
  if (selectedObjects.length === 1) {
    const obj = selectedObjects[0];

    // If it's a child object in a group, only allow editing if selected from sidebar
    if (isChildObjectInGroup(obj)) {
      return isChildObjectSelectedFromSidebar(obj);
    }

    // Otherwise, always allow editing
    return true;
  }

  // Multiple objects selected - transforms are disabled
  // Users can still delete or duplicate, but not transform
  if (selectedObjects.length > 1) {
    return false;
  }

  return false;
}

function isChildObjectInGroup(obj){
  return obj.parent && obj.parent.userData?.isEditorGroup === true;
}

function isChildObjectSelectedFromSidebar(obj){
  // Check if this object is a child of a group and was selected from sidebar
  if (!isChildObjectInGroup(obj)) return false;

  // Check if the object has a list item that's nested under a group
  const listItem = obj.userData?.listItem;
  if (!listItem) return false;

  // Check if this list item is nested under a group's child list
  const parentLi = listItem.parentElement;
  if (!parentLi || parentLi.tagName !== 'UL') return false;

  const groupLi = parentLi.previousElementSibling;
  if (!groupLi || !groupLi.querySelector('.caret')) return false;

  return true;
}

// ===== Selection (unified) =====
function selectObject(obj, additive=false, toggle=false){
  if (!additive && !toggle) {
    selectedObjects.forEach(o=>{
      o.userData.listItem?.classList.remove("selected");
      setHelperVisible(o,false);
      // Hide parent box helper if object is a child in a group
      if (isChildObjectInGroup(o) && o.parent) {
        setParentHelperVisible(o.parent, false);
      }
      // Hide child bounding boxes if object is a group
      if (o.userData?.isEditorGroup) {
        showChildBoundingBoxes(o, false);
      }
      if (o.userData.dimGroup) scene.remove(o.userData.dimGroup);
    });
    selectedObjects = [];
    updateTransformButtonStates();
  }

  if (toggle && selectedObjects.includes(obj)) {
    selectedObjects = selectedObjects.filter(o=>o!==obj);
    obj.userData.listItem?.classList.remove("selected");
    setHelperVisible(obj,false);
    // Hide parent box helper if object is a child in a group
    if (isChildObjectInGroup(obj) && obj.parent) {
      setParentHelperVisible(obj.parent, false);
    }
    // Hide child bounding boxes if object is a group
    if (obj.userData?.isEditorGroup) {
      showChildBoundingBoxes(obj, false);
    }
    updatePropertiesPanel(selectedObjects[selectedObjects.length-1] || null);
    updateTransformButtonStates();
    return;
  }

  if (!selectedObjects.includes(obj)) selectedObjects.push(obj);
  selectedObject = obj;

  obj.userData.listItem?.classList.add("selected");

  // Ensure the object has a box helper
  if (!obj.userData.boxHelper) {
    createBoxHelperFor(obj);
  }

  setHelperVisible(obj,true);
  updateBoxHelper(obj, BOX_COLORS.selected);

  // If this is a child object in a group, also show the parent group's bounding box
  if (isChildObjectInGroup(obj) && obj.parent) {
    const parentGroup = obj.parent;
    // Create parent box helper if it doesn't exist
    if (!parentGroup.userData.parentBoxHelper) {
      createParentBoxHelperFor(parentGroup);
    }
    setParentHelperVisible(parentGroup, true);
    updateParentBoxHelper(parentGroup, 0x888888); // Gray color for parent
  }

  // If this is a parent group, show child bounding boxes in gray
  if (obj.userData?.isEditorGroup) {
    showChildBoundingBoxes(obj, true, 0x888888); // Gray color for children
  }

  addBoundingBoxDimensions(obj);
  updateModelProperties(obj);
  updatePropertiesPanel(obj);
  updateTransformButtonStates();
}

function selectFromSidebar(obj, li, e){
  const additive = !!(e && (e.shiftKey||e.ctrlKey||e.metaKey));
  const toggle = !!(e && (e.ctrlKey||e.metaKey));
  selectObject(obj, additive, toggle);
}

function selectFromCanvas(obj, additive){
  selectObject(obj, !!additive, false);
}

// ===== Sidebar (DRY creation) =====
function createSidebarItem(obj, name, isGroup=false, parentList=null){
  const li = document.createElement("li");
  let caret = null;
  const label = document.createElement("span");
  label.textContent = name;

  // Make list item draggable
  li.draggable = true;
  li.setAttribute('data-object-id', obj.uuid);

  if (isGroup) {
    caret = document.createElement("span");
    caret.className = "caret";
    caret.title = "Toggle children";
    caret.addEventListener("click", e=>{
      e.stopPropagation();
      setGroupExpanded(li, !(caret.classList.contains("expanded")));
    });
    li.appendChild(caret);
  }

  li.appendChild(label);

  li.onclick = e => selectFromSidebar(obj, li, e);
  li.ondblclick = e => {
    if (e.target === label) makeLabelEditable(label, obj);
    else { selectFromSidebar(obj, li, e); frameCameraOn(obj); }
  };

  // Drag and drop event handlers
  li.addEventListener('dragstart', handleDragStart);
  li.addEventListener('dragend', handleDragEnd);
  li.addEventListener('dragover', handleDragOver);
  li.addEventListener('dragenter', handleDragEnter);
  li.addEventListener('dragleave', handleDragLeave);
  li.addEventListener('drop', handleDrop);

  obj.userData.listItem = li;
  const targetList = parentList || modelList;
  targetList.appendChild(li);

  if (isGroup) {
    const childList = ensureChildList(li);
    childList.classList.add("children-collapsed");
  }
}


function addGroupToList(group, name, parentList = null){
  const targetList = parentList || modelList;
  createSidebarItem(group, name, true, targetList);
  group.userData.listType = "group";
  const childList = group.userData.listItem.nextSibling;

  // Skip the first child (parent object) and only show other children
  const childrenToShow = group.children.slice(1);
  childrenToShow.forEach(child=>{
    if (child.userData?.isEditorGroup) {
      // This is a nested group - add it recursively
      addGroupToList(child, child.name || "Attached", childList);
    } else {
      // This is a regular model - add it as a child item
      addModelToList(child, child.name || "Model", childList);
    }
  });
}

function addModelToList(model, name, parentList = null){
  const targetList = parentList || modelList;
  createSidebarItem(model, name, false, targetList);
  model.userData.listType = "model";
}

function rebuildGroupSidebar(group) {
  if (!group || !group.userData?.isEditorGroup) return;

  // Remove existing child list items
  const groupLi = group.userData.listItem;
  if (!groupLi) return;

  const childList = groupLi.nextSibling;
  if (childList && childList.tagName === "UL") {
    // Clear all child items
    while (childList.firstChild) {
      childList.removeChild(childList.firstChild);
    }

    // Skip the first child (parent object) and only show other children
    const childrenToShow = group.children.slice(1);
    childrenToShow.forEach(child => {
      if (child.userData?.isEditorGroup) {
        // This is a nested group - add it recursively
        addGroupToList(child, child.name || "Attached", childList);
      } else {
        // This is a regular model - add it as a child item
        addModelToList(child, child.name || "Model", childList);
      }
    });
  }
}

function ensureChildList(li){
  let childList = li.nextSibling;
  if (!(childList && childList.tagName === "UL")) {
    childList = document.createElement("ul");
    childList.style.listStyle = "none";
    childList.style.paddingLeft = "12px";
    childList.style.margin = "4px 0 6px 0";
    li.after(childList);
  }
  return childList;
}

function setGroupExpanded(li, expanded){
  const caret = li.querySelector(".caret");
  const childList = ensureChildList(li);
  if (expanded) {
    caret?.classList.add("expanded");
    childList.classList.remove("children-collapsed");
    childList.style.display = "block";
  } else {
    caret?.classList.remove("expanded");
    childList.classList.add("children-collapsed");
    childList.style.display = "none";
  }
}

// ===== Inline renaming =====
function makeLabelEditable(label, obj){
  const input = document.createElement("input");
  input.type = "text";
  input.value = label.textContent;
  input.style.width = "80%";

  label.replaceWith(input);
  input.focus();

  const finish = () => {
    obj.name = (input.value.trim() || obj.name || "Unnamed");
    const newLabel = document.createElement("span");
    newLabel.textContent = obj.name;
    newLabel.ondblclick = () => makeLabelEditable(newLabel, obj);
    input.replaceWith(newLabel);
    obj.userData.listItem.firstChild = newLabel;
  };
  input.addEventListener("blur", finish);
  input.addEventListener("keydown", e=>{
    if (e.key === "Enter") finish();
    if (e.key === "Escape") { input.value = obj.name; finish(); }
  });
}

function renameSelectedObject(){
  if (selectedObjects.length !== 1) return;
  const li = selectedObjects[0].userData.listItem;
  const label = li?.querySelector("span");
  if (label) makeLabelEditable(label, selectedObjects[0]);
}


// ===== Ruler =====
function createRuler(size, step=1){
  const group = new THREE.Group();
  const mat = new THREE.LineBasicMaterial({color:0xaaaaaa});
  for(let i=-size/2;i<=size/2;i+=step){
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(i,0,-size/2),new THREE.Vector3(i,0.1,-size/2)]), mat));
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(i,0,size/2),new THREE.Vector3(i,0.1,size/2)]), mat));
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-size/2,0,i),new THREE.Vector3(-size/2,0.1,i)]), mat));
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(size/2,0,i),new THREE.Vector3(size/2,0.1,i)]), mat));
  }
  return group;
}

function addRulerLabels(group, size, step, font){
  const mat = new THREE.MeshBasicMaterial({color:0xaaaaaa});
  for(let i=-size/2;i<=size/2;i+=step){
    if(i===0) continue;
    const labelX = new THREE.Mesh(new THREE.TextGeometry(`${i}m`,{font,size:LABEL_SIZE,height:0}), mat);
    labelX.position.set(i,0.1,-size/2-LABEL_OFFSET);
    group.add(labelX);

    const labelZ = new THREE.Mesh(new THREE.TextGeometry(`${i}m`,{font,size:LABEL_SIZE,height:0}), mat);
    labelZ.position.set(-size/2-LABEL_OFFSET,0.1,i);
    group.add(labelZ);
  }
}

// ===== Human height guide (5'9" ≈ 1.75m) =====
function createHumanGuide(heightMeters=HUMAN_HEIGHT){
  const group = new THREE.Group();
  const color = 0x66aaff; // subtle bluish
  const opacity = 0.25;
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide });

  // Proportions
  const headRadius = Math.min(0.09, heightMeters * 0.062);
  const legHeight = heightMeters * 0.50;
  const torsoHeight = heightMeters * 0.45;
  const shoulderWidth = heightMeters * 0.28;
  const waistWidth = heightMeters * 0.18;
  const limbWidth = Math.max(0.02, heightMeters * 0.06);
  const armLength = torsoHeight * 0.9;

  // Torso
  const torsoTop = new THREE.Mesh(new THREE.PlaneGeometry(shoulderWidth, torsoHeight * 0.55), mat);
  torsoTop.position.y = legHeight + (torsoHeight * 0.75);
  const torsoBottom = new THREE.Mesh(new THREE.PlaneGeometry(waistWidth, torsoHeight * 0.45), mat);
  torsoBottom.position.y = legHeight + (torsoHeight * 0.275);

  // Legs
  const legGeo = new THREE.PlaneGeometry(limbWidth, legHeight);
  const legL = new THREE.Mesh(legGeo, mat);
  legL.position.set(-waistWidth * 0.25, legHeight * 0.5, 0);
  const legR = new THREE.Mesh(legGeo.clone(), mat);
  legR.position.set(waistWidth * 0.25, legHeight * 0.5, 0);

  // Arms
  const armGeo = new THREE.PlaneGeometry(limbWidth, armLength);
  const armL = new THREE.Mesh(armGeo, mat);
  armL.position.set(-shoulderWidth * 0.5, legHeight + torsoHeight - armLength * 0.5, 0);
  const armR = new THREE.Mesh(armGeo.clone(), mat);
  armR.position.set(shoulderWidth * 0.5, legHeight + torsoHeight - armLength * 0.5, 0);

  // Head
  const head = new THREE.Mesh(new THREE.CircleGeometry(headRadius, 24), mat);
  head.position.y = legHeight + torsoHeight + headRadius * 1.05;

  // Crossed for visibility
  const axisGroupA = new THREE.Group();
  axisGroupA.add(torsoTop, torsoBottom, legL, legR, armL, armR, head);
  const axisGroupB = axisGroupA.clone();
  axisGroupB.traverse(node=>{ if (node.isMesh) node.geometry = node.geometry.clone(); });
  axisGroupB.rotation.y = Math.PI / 2;

  group.add(axisGroupA, axisGroupB);

  // Non-interactive
  group.userData.isSelectable = false;
  group.traverse(o=>{ o.userData.isSelectable = false; o.raycast = () => {}; });
  group.name = "HumanGuide";
  return group;
}

// Scale down any model so its height does not exceed HUMAN_HEIGHT
function fitModelToMaxHeight(obj, maxHeightMeters=HUMAN_HEIGHT){
  const box = new THREE.Box3().setFromObject(obj);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  if (size.y <= 0) return;
  if (size.y > maxHeightMeters) {
    const k = maxHeightMeters / size.y;
    obj.scale.multiplyScalar(k);
  }
}


// ===== File loading (preserve original pivot & transform) =====
fileInput.addEventListener("change", e=>{
  const file = e.target.files[0]; if(!file) return;
  const url = URL.createObjectURL(file);
  loader.load(url, gltf=>{
    const model = gltf.scene;
    model.userData.isSelectable = true;
    model.name = (file.name || ("Model "+modelCounter++)).replace(/\.[^/.]+$/, "");
    // Track original source for export/reference reuse
    model.userData.sourceRef = {
      originalFileName: file.name,
      baseName: model.name,
      reference: model.name + ".glb"
    };
    createBoxHelperFor(model);

    // Enforce maximum height relative to human guide
    fitModelToMaxHeight(model, HUMAN_HEIGHT);
    scene.add(model);

    addModelToList(model, model.name);
    storeInitialTransform(model);
    selectObject(model);
    updateBoxHelper(model);
    frameCameraOn(model);
    saveState();
  });
});

// ===== Attach / Detach =====
// DEPRECATED: Use drag-and-drop attaching instead
function groupSelectedObjects(){
  if (selectedObjects.length < 2) return;

  // Use the first (top-most) selected object as the parent group
  const parentObj = selectedObjects[0];
  const otherObjects = selectedObjects.slice(1);

  // Convert the parent object to a group
  const group = new THREE.Group();
  group.userData.isSelectable = true;
  group.userData.isEditorGroup = true;
  group.name = parentObj.name || "Attached " + Date.now();

  // Copy parent object's transform to the group
  group.position.copy(parentObj.position);
  group.quaternion.copy(parentObj.quaternion);
  group.scale.copy(parentObj.scale);

  // Remove parent object from scene and add it as first child of group
  scene.remove(parentObj);
  group.add(parentObj);

  // Reset parent object's transform relative to group
  parentObj.position.set(0, 0, 0);
  parentObj.quaternion.set(0, 0, 0, 1);
  parentObj.scale.set(1, 1, 1);

  // Clean up parent object's sidebar representation
  if (parentObj.userData.listItem) {
    const li = parentObj.userData.listItem;
    const next = li.nextSibling;
    li.remove();
    if(next && next.tagName==="UL") next.remove();
    delete parentObj.userData.listItem;
  }

  // Add other objects to the group
  otherObjects.forEach(obj=>{
    // Remember how this object appeared in the sidebar before grouping
    if (!obj.userData) obj.userData = {};
    obj.userData.originalListType = obj.userData.listType || (obj instanceof THREE.Group ? "group" : "model");
    obj.userData.originalName = obj.name;
    if(obj.userData.boxHelper){ scene.remove(obj.userData.boxHelper); delete obj.userData.boxHelper; }
    if(obj.userData.dimGroup){ scene.remove(obj.userData.dimGroup); delete obj.userData.dimGroup; }
    group.attach(obj);
    if (obj.userData.listItem) {
      const li = obj.userData.listItem;
      const next = li.nextSibling;
      li.remove();
      if(next && next.tagName==="UL") next.remove();
      delete obj.userData.listItem;
    }
  });

  scene.add(group);
  createBoxHelperFor(group);
  createParentBoxHelperFor(group);
  addGroupToList(group, group.name);
  storeInitialTransform(group);
  selectObject(group);
  updateAllVisuals(group);
}

function ungroupSelectedObject(){
  if (selectedObjects.length !== 1) return;
  let group = selectedObjects[0];

  // If the selected object is a child in a group (not the group itself), dissolve the parent group
  if (isChildObjectInGroup(group)) {
    group = group.parent;
  }

  if (!(group instanceof THREE.Group)) return;
  if (!group.userData || group.userData.isEditorGroup !== true) return;

  // Hide child bounding boxes before detaching
  showChildBoundingBoxes(group, false);

  // Remember the group's parent (could be scene or another group)
  const groupParent = group.parent || scene;
  const wasInParentGroup = groupParent && groupParent !== scene && groupParent.userData?.isEditorGroup;

  while (group.children.length > 0) {
    const child = group.children[0];

    // Move child to the group's parent (preserving world transform)
    if (groupParent === scene) {
      scene.attach(child);
    } else {
      groupParent.attach(child);
    }

    createBoxHelperFor(child);
    // Hide the child's bounding box after detaching
    setHelperVisible(child, false);

    // Restore original sidebar representation and label
    if (child.userData?.originalName) child.name = child.userData.originalName;
    const listType = child.userData?.originalListType || child.userData?.listType || (child instanceof THREE.Group ? "group" : "model");

    // Sidebar will be rebuilt below if we're in a parent group
    // Otherwise add to root of sidebar
    if (!wasInParentGroup) {
      if (listType === "group") addGroupToList(child, child.name || "Attached");
      else addModelToList(child, child.name || "Model");
    }

    delete child.userData?.originalListType;
    delete child.userData?.originalName;

    // Update visuals without clamping to preserve world positions during detaching
    updateModelProperties(child);
    updatePropertiesPanel(child);
    updateBoxHelper(child);

    // If this is a group, also update child bounding boxes
    if (child.userData?.isEditorGroup) {
      updateChildBoundingBoxes(child);
    }
  }

  // Clean up the group
  cleanupObject(group);
  if (group.parent) {
    group.parent.remove(group);
  } else {
    scene.remove(group);
  }

  // If the group was inside another group, rebuild that parent's sidebar
  if (wasInParentGroup) {
    rebuildGroupSidebar(groupParent);
  }

  selectedObjects = [];
  selectedObject = null;
  transform.detach();
  updatePropertiesPanel(null);
}

function detachFromGroup(obj, skipSelection = false){
  if (!obj) return false;
  
  // Check if object is a child in a group
  if (!isChildObjectInGroup(obj)) return false;
  
  const parentGroup = obj.parent;
  
  // Only allow detaching if there are at least 2 non-parent children
  // (total children >= 3: parent + at least 2 other children)
  if (parentGroup.children.length < 3) {
    console.warn("Cannot detach: group must have at least 2 non-parent children. Use 'Detach' to dissolve the group instead.");
    return false;
  }
  
  // Hide parent box helper
  if (parentGroup.userData.parentBoxHelper) {
    setParentHelperVisible(parentGroup, false);
  }
  
  // Move object to the parent group's parent (preserving world transform)
  const grandParent = parentGroup.parent || scene;
  const wasInParentGroup = grandParent && grandParent !== scene && grandParent.userData?.isEditorGroup;
  
  if (grandParent === scene) {
    scene.attach(obj);
  } else {
    grandParent.attach(obj);
  }
  
  createBoxHelperFor(obj);
  setHelperVisible(obj, false);
  
  // Restore original sidebar representation and label
  if (obj.userData?.originalName) obj.name = obj.userData.originalName;
  const listType = obj.userData?.originalListType || obj.userData?.listType || (obj instanceof THREE.Group ? "group" : "model");
  
  // Sidebar will be rebuilt below if we're in a parent group
  // Otherwise add to root of sidebar
  if (!wasInParentGroup) {
    if (listType === "group") addGroupToList(obj, obj.name || "Attached");
    else addModelToList(obj, obj.name || "Model");
  }
  
  delete obj.userData?.originalListType;
  delete obj.userData?.originalName;
  
  // Update visuals without clamping to preserve world positions during detaching
  updateModelProperties(obj);
  updatePropertiesPanel(obj);
  updateBoxHelper(obj);
  
  // If this is a group, also update child bounding boxes
  if (obj.userData?.isEditorGroup) {
    updateChildBoundingBoxes(obj);
  }
  
  // Rebuild the parent group's sidebar
  rebuildGroupSidebar(parentGroup);
  
  // If we're in a nested group, rebuild that too
  if (wasInParentGroup) {
    rebuildGroupSidebar(grandParent);
  }
  
  // Update parent group's bounding boxes
  updateParentGroupBounds(parentGroup);
  
  // Keep the object selected after detaching (unless we're batch detaching)
  if (!skipSelection) {
    selectObject(obj);
    saveState();
  }
  
  return true;
}

function detachSelectedFromGroup(){
  if (selectedObjects.length === 0) return;
  
  // Detach all selected objects that are children in groups
  const objectsToDetach = selectedObjects.filter(obj => {
    if (!isChildObjectInGroup(obj)) return false;
    const parentGroup = obj.parent;
    // Only allow if parent group has at least 3 children (parent + 2 non-parent children)
    return parentGroup.children.length >= 3;
  });
  
  if (objectsToDetach.length === 0) return;
  
  // Clear current selection and hide all bounding boxes first
  selectedObjects.forEach(obj => {
    obj.userData.listItem?.classList.remove("selected");
    setHelperVisible(obj, false);
    if (obj.userData.dimGroup) scene.remove(obj.userData.dimGroup);
    // Also hide parent box helpers
    if (isChildObjectInGroup(obj) && obj.parent) {
      setParentHelperVisible(obj.parent, false);
    }
  });
  selectedObjects = [];
  selectedObject = null;
  transform.detach();
  
  // Detach all objects without selecting them individually
  const detachedObjects = [];
  objectsToDetach.forEach(obj => {
    const success = detachFromGroup(obj, true); // skipSelection = true
    if (success) {
      detachedObjects.push(obj);
    }
  });
  
  // Now select all successfully detached objects at once
  if (detachedObjects.length > 0) {
    selectedObjects = [...detachedObjects];
    selectedObject = detachedObjects[detachedObjects.length - 1];
    
    // Show selection for all detached objects
    detachedObjects.forEach(obj => {
      obj.userData.listItem?.classList.add("selected");
      setHelperVisible(obj, true);
      updateBoxHelper(obj, BOX_COLORS.selected);
      addBoundingBoxDimensions(obj);
    });
    
    updateModelProperties(selectedObject);
    updatePropertiesPanel(selectedObject);
    updateTransformButtonStates();
    saveState();
  }
}

// ===== Helper function to check if group should be removed =====
function shouldRemoveEmptyGroup(group) {
  if (!group || !group.userData?.isEditorGroup) return false;

  // If group has only 1 child (the parent object), it should be removed
  // If group has 0 children, it should definitely be removed
  return group.children.length <= 1;
}

function cleanupEmptyParentGroups(parentGroup) {
  if (!parentGroup || !parentGroup.userData?.isEditorGroup) return;

  if (shouldRemoveEmptyGroup(parentGroup)) {
    const grandParent = parentGroup.parent;

    // If there's still one child (the parent object), restore it to the scene
    if (parentGroup.children.length === 1) {
      const parentObject = parentGroup.children[0];

      // Restore the parent object's transform and add it back to scene
      scene.attach(parentObject);

      // Restore original sidebar representation
      // For the parent object (first child), it might not have originalName/originalListType
      // so we use the group's name and determine type based on object type
      if (parentObject.userData?.originalName) {
        parentObject.name = parentObject.userData.originalName;
      } else {
        // Use the group's name as fallback since the parent object was the basis for the group
        parentObject.name = parentGroup.name || parentObject.name || "Model";
      }

      const listType = parentObject.userData?.originalListType ||
                      (parentObject instanceof THREE.Group && parentObject.userData?.isEditorGroup ? "group" : "model");

      if (listType === "group") {
        addGroupToList(parentObject, parentObject.name || "Attached");
      } else {
        addModelToList(parentObject, parentObject.name || "Model");
      }

      // Clean up the metadata
      delete parentObject.userData?.originalListType;
      delete parentObject.userData?.originalName;

      // Create box helper for the restored object
      createBoxHelperFor(parentObject);
      updateAllVisuals(parentObject);
    }

    // Clean up and remove the empty group
    cleanupObject(parentGroup);
    if (parentGroup.parent) {
      parentGroup.parent.remove(parentGroup);
    } else {
      scene.remove(parentGroup);
    }

    // Recursively check if the grandparent group should also be removed
    if (grandParent && grandParent !== scene) {
      cleanupEmptyParentGroups(grandParent);
    }
  }
}

// ===== Drag and Drop Attaching =====
function handleDragStart(e) {
  const li = e.target.closest('li');
  if (!li) return;

  const objectId = li.getAttribute('data-object-id');
  draggedObject = scene.getObjectByProperty('uuid', objectId);
  draggedItem = li;

  // Check if the dragged object is part of the current selection
  if (selectedObjects.includes(draggedObject)) {
    // Drag all selected objects
    draggedObjects = [...selectedObjects];
    // Add visual feedback to all selected items
    selectedObjects.forEach(obj => {
      if (obj.userData.listItem) {
        obj.userData.listItem.classList.add('dragging');
        if (selectedObjects.length > 1) {
          obj.userData.listItem.classList.add('multi-select');
        }
      }
    });
  } else {
    // Drag only the single object
    draggedObjects = [draggedObject];
    li.classList.add('dragging');
  }

  // Set drag effect
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', objectId);
}

function handleDragEnd(e) {
  // Clean up drag state and visual feedback for all dragged objects
  draggedObjects.forEach(obj => {
    if (obj.userData.listItem) {
      obj.userData.listItem.classList.remove('dragging');
      obj.userData.listItem.classList.remove('multi-select');
    }
  });

  // Remove drag-over class from all items
  document.querySelectorAll('#modelList li.drag-over').forEach(item => {
    item.classList.remove('drag-over');
  });

  // Reset drag state
  draggedObject = null;
  draggedObjects = [];
  draggedItem = null;
}

function handleDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
}

function handleDragEnter(e) {
  e.preventDefault();
  const li = e.target.closest('li');
  if (!li || li === draggedItem) return;

  const targetObjectId = li.getAttribute('data-object-id');
  const targetObject = scene.getObjectByProperty('uuid', targetObjectId);

  // Check if this is a valid drop target for all dragged objects
  const allValid = draggedObjects.every(draggedObj =>
    isValidDropTarget(draggedObj, targetObject)
  );

  if (allValid) {
    li.classList.add('drag-over');
  }
}

function handleDragLeave(e) {
  const li = e.target.closest('li');
  if (!li) return;

  // Only remove drag-over if we're actually leaving the element
  const rect = li.getBoundingClientRect();
  const x = e.clientX;
  const y = e.clientY;

  if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
    li.classList.remove('drag-over');
  }
}

function handleDrop(e) {
  e.preventDefault();
  e.stopPropagation();

  const li = e.target.closest('li');
  if (!li || li === draggedItem) return;

  const targetObjectId = li.getAttribute('data-object-id');
  const targetObject = scene.getObjectByProperty('uuid', targetObjectId);

  // Clean up visual feedback
  li.classList.remove('drag-over');
  draggedObjects.forEach(obj => {
    if (obj.userData.listItem) {
      obj.userData.listItem.classList.remove('dragging');
      obj.userData.listItem.classList.remove('multi-select');
    }
  });

  // Perform the grouping operation for multiple objects
  if (draggedObjects.length > 0 && targetObject) {
    // Validate all objects can be dropped
    const allValid = draggedObjects.every(draggedObj =>
      isValidDropTarget(draggedObj, targetObject)
    );

    if (allValid) {
      createGroupFromMultipleDragDrop(draggedObjects, targetObject);
    }
  }

  // Reset drag state
  draggedObject = null;
  draggedObjects = [];
  draggedItem = null;
}

function isValidDropTarget(draggedObj, targetObj) {
  if (!draggedObj || !targetObj) return false;
  if (draggedObj === targetObj) return false;

  // Prevent dropping a parent group onto its own child
  if (isDescendantOf(targetObj, draggedObj)) return false;

  // Prevent dropping a child object onto its parent group
  if (draggedObj.parent && draggedObj.parent.userData?.isEditorGroup && targetObj === draggedObj.parent) {
    return false;
  }

  // Restrict: If dragged object is a child in a group, only allow dropping within its own parent group
  // This allows nesting child elements within the same group
  if (draggedObj.parent && draggedObj.parent.userData?.isEditorGroup) {
    const draggedParent = draggedObj.parent;
    // Allow dropping onto:
    // 1. Siblings within the same parent group (for nesting)
    // Note: Dropping onto the parent group itself is now prevented above
    if (targetObj.parent !== draggedParent) {
      return false;
    }
  }

  // Groups can be dropped onto other groups (to add as children)
  // or onto regular objects (to create nested groups)
  // Child elements can be nested into other children within the same parent group

  return true;
}

function isDescendantOf(obj, ancestor) {
  let current = obj.parent;
  while (current && current !== scene) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

function createGroupFromDragDrop(draggedObj, targetObj) {
  // If target is already a group, just add the dragged object to it
  if (targetObj instanceof THREE.Group && targetObj.userData?.isEditorGroup) {
    addObjectToExistingGroup(draggedObj, targetObj);
    return;
  }

  // Create a new group with target as parent
  const group = new THREE.Group();
  group.userData.isSelectable = true;
  group.userData.isEditorGroup = true;
  group.name = targetObj.name || "Attached " + Date.now();

  // Copy target object's transform to the group
  group.position.copy(targetObj.position);
  group.quaternion.copy(targetObj.quaternion);
  group.scale.copy(targetObj.scale);

  // Remember if target was in a parent group
  const targetParent = targetObj.parent;
  const wasInGroup = targetParent && targetParent.userData?.isEditorGroup;

  // Remove target object from its current parent and add it as first child of group
  if (targetParent) {
    targetParent.remove(targetObj);
  } else {
    scene.remove(targetObj);
  }
  group.add(targetObj);

  // Reset target object's transform relative to group
  targetObj.position.set(0, 0, 0);
  targetObj.quaternion.set(0, 0, 0, 1);
  targetObj.scale.set(1, 1, 1);

  // Clean up target object's sidebar representation
  if (targetObj.userData.listItem) {
    const li = targetObj.userData.listItem;
    const next = li.nextSibling;
    li.remove();
    if(next && next.tagName==="UL") next.remove();
    delete targetObj.userData.listItem;
  }

  // Add group to scene or parent FIRST (before adding dragged object)
  // This ensures the group has a valid world matrix for transform calculations
  if (wasInGroup) {
    targetParent.add(group);
  } else {
    scene.add(group);
  }

  // Now add dragged object to the group (world transform will be preserved correctly)
  addObjectToGroup(draggedObj, group);

  // Update visuals and sidebar
  if (wasInGroup) {
    rebuildGroupSidebar(targetParent);

    // For nested groups, only update visuals (no clamping)
    updateModelProperties(group);
    updatePropertiesPanel(group);
    updateBoxHelper(group);
    updateChildBoundingBoxes(group);
    updateParentGroupBounds(targetParent);
  } else {
    createBoxHelperFor(group);
    createParentBoxHelperFor(group);
    addGroupToList(group, group.name);

    // For top-level groups, apply clamping
    updateAllVisuals(group);
  }

  storeInitialTransform(group);
  selectObject(group);
  saveState();
}

function addObjectToExistingGroup(obj, group) {
  // If the object is already a direct child of the target group, do nothing
  if (obj.parent === group) {
    return;
  }

  // Remove object from its current parent
  const objParent = obj.parent;
  if (objParent) {
    objParent.remove(obj);
    if (objParent.userData?.isEditorGroup) {
      rebuildGroupSidebar(objParent);
      // Check if parent group should be cleaned up after removing the object
      cleanupEmptyParentGroups(objParent);
    }
  } else {
    scene.remove(obj);
  }

  // Add to the target group (this will handle sidebar cleanup and world transform preservation)
  addObjectToGroup(obj, group);

  // Rebuild the group's sidebar
  rebuildGroupSidebar(group);

  // Update visuals without clamping to preserve world positions
  updateModelProperties(group);
  updatePropertiesPanel(group);
  updateBoxHelper(group);

  // If this is a group, also update child bounding boxes
  if (group.userData?.isEditorGroup) {
    updateChildBoundingBoxes(group);
  }

  // If this object is a child in a group, update the parent group's bounding box
  if (isChildObjectInGroup(group) && group.parent) {
    updateParentGroupBounds(group.parent);
  }

  saveState();
}

function addObjectToGroup(obj, group) {
  // Store original metadata
  if (!obj.userData) obj.userData = {};
  obj.userData.originalListType = obj.userData.listType || (obj instanceof THREE.Group ? "group" : "model");
  obj.userData.originalName = obj.name;

  // Clean up existing helpers
  if(obj.userData.boxHelper){ scene.remove(obj.userData.boxHelper); delete obj.userData.boxHelper; }
  if(obj.userData.dimGroup){ scene.remove(obj.userData.dimGroup); delete obj.userData.dimGroup; }

  // Remove from current sidebar listing
  if (obj.userData.listItem) {
    const li = obj.userData.listItem;
    const next = li.nextSibling;
    li.remove();
    if(next && next.tagName==="UL") next.remove();
    delete obj.userData.listItem;
  }

  // --- World transform preservation logic ---
  // 1. Store world transform before moving
  const worldPosition = new THREE.Vector3();
  const worldQuaternion = new THREE.Quaternion();
  const worldScale = new THREE.Vector3();
  obj.getWorldPosition(worldPosition);
  obj.getWorldQuaternion(worldQuaternion);
  obj.getWorldScale(worldScale);

  // 2. Ensure the group and all ancestors are in the scene and matrices are up-to-date
  scene.updateMatrixWorld(true);

  // 3. Calculate the correct local transform
  const groupWorldMatrix = new THREE.Matrix4();
  group.updateMatrixWorld(true);
  groupWorldMatrix.copy(group.matrixWorld);

  const targetWorldMatrix = new THREE.Matrix4();
  targetWorldMatrix.compose(worldPosition, worldQuaternion, worldScale);

  const localMatrix = new THREE.Matrix4();
  localMatrix.copy(groupWorldMatrix).invert().multiply(targetWorldMatrix);

  // 4. Decompose and set the local transform
  const localPosition = new THREE.Vector3();
  const localQuaternion = new THREE.Quaternion();
  const localScale = new THREE.Vector3();
  localMatrix.decompose(localPosition, localQuaternion, localScale);

  obj.position.copy(localPosition);
  obj.quaternion.copy(localQuaternion);
  obj.scale.copy(localScale);

  // 5. Now add to group - the transform should already be correct
  group.add(obj);

  // (Optional) Verify the world transform is preserved
  // const verifyWorldPosition = new THREE.Vector3();
  // obj.getWorldPosition(verifyWorldPosition);
  // if (!worldPosition.equals(verifyWorldPosition, 0.001)) {
  //   console.warn('World transform not preserved:', worldPosition, verifyWorldPosition);
  // }
}

function createGroupFromMultipleDragDrop(draggedObjects, targetObj) {
  if (draggedObjects.length === 0) return;

  // If target is already a group, add all objects to it
  if (targetObj instanceof THREE.Group && targetObj.userData?.isEditorGroup) {
    draggedObjects.forEach(draggedObj => {
      addObjectToExistingGroup(draggedObj, targetObj);
    });
    return;
  }

  // Create a new group with target as parent
  const group = new THREE.Group();
  group.userData.isSelectable = true;
  group.userData.isEditorGroup = true;
  group.name = targetObj.name || "Attached " + Date.now();

  // Copy target object's transform to the group
  group.position.copy(targetObj.position);
  group.quaternion.copy(targetObj.quaternion);
  group.scale.copy(targetObj.scale);

  // Remember if target was in a parent group
  const targetParent = targetObj.parent;
  const wasInGroup = targetParent && targetParent.userData?.isEditorGroup;

  // Remove target object from its current parent and add it as first child of group
  if (targetParent) {
    targetParent.remove(targetObj);
  } else {
    scene.remove(targetObj);
  }
  group.add(targetObj);

  // Reset target object's transform relative to group
  targetObj.position.set(0, 0, 0);
  targetObj.quaternion.set(0, 0, 0, 1);
  targetObj.scale.set(1, 1, 1);

  // Clean up target object's sidebar representation
  if (targetObj.userData.listItem) {
    const li = targetObj.userData.listItem;
    const next = li.nextSibling;
    li.remove();
    if(next && next.tagName==="UL") next.remove();
    delete targetObj.userData.listItem;
  }

  // Add group to scene or parent FIRST (before adding dragged objects)
  // This ensures the group has a valid world matrix for transform calculations
  if (wasInGroup) {
    targetParent.add(group);
  } else {
    scene.add(group);
  }

  // Now add all dragged objects to the group (world transforms will be preserved correctly)
  draggedObjects.forEach(draggedObj => {
    addObjectToGroup(draggedObj, group);
  });

  // Update visuals and sidebar
  if (wasInGroup) {
    rebuildGroupSidebar(targetParent);

    // For nested groups, only update visuals (no clamping)
    updateModelProperties(group);
    updatePropertiesPanel(group);
    updateBoxHelper(group);
    updateChildBoundingBoxes(group);
    updateParentGroupBounds(targetParent);
  } else {
    createBoxHelperFor(group);
    createParentBoxHelperFor(group);
    addGroupToList(group, group.name);

    // For top-level groups, apply clamping
    updateAllVisuals(group);
  }

  storeInitialTransform(group);
  selectObject(group);
  saveState();
}

// ===== Duplication =====
function duplicateObject(obj, offset = new THREE.Vector3(1, 0, 1)) {
  if (!obj || !obj.userData?.isSelectable) return null;

  let duplicate;

  if (obj instanceof THREE.Group && obj.userData?.isEditorGroup) {
    // Handle editor groups
    duplicate = new THREE.Group();
    duplicate.userData.isSelectable = true;
    duplicate.userData.isEditorGroup = true;

    // Copy transform
    duplicate.position.copy(obj.position).add(offset);
    duplicate.quaternion.copy(obj.quaternion);
    duplicate.scale.copy(obj.scale);

    // Generate unique name
    duplicate.name = generateUniqueName(obj.name || "Attached");

    // Copy source reference from the first child (parent object)
    if (obj.children[0]?.userData?.sourceRef) {
      duplicate.userData.sourceRef = { ...obj.children[0].userData.sourceRef };
    }

    // Duplicate all children
    obj.children.forEach(child => {
      const childDuplicate = duplicateObject(child, new THREE.Vector3(0, 0, 0)); // No offset for children
      if (childDuplicate) {
        duplicate.add(childDuplicate);
      }
    });
  } else {
    // Handle regular models
    duplicate = obj.clone(true); // Deep clone with children

    // Deep clone materials and geometries to avoid sharing
    duplicate.traverse(node => {
      if (node.isMesh) {
        if (node.material) {
          if (Array.isArray(node.material)) {
            node.material = node.material.map(mat => mat.clone());
          } else {
            node.material = node.material.clone();
          }
        }
        if (node.geometry) {
          node.geometry = node.geometry.clone();
        }
      }
    });

    // Copy and update userData
    duplicate.userData = { ...obj.userData };
    duplicate.userData.isSelectable = true;

    // Copy source reference
    if (obj.userData?.sourceRef) {
      duplicate.userData.sourceRef = { ...obj.userData.sourceRef };
    }

    // Generate unique name
    duplicate.name = generateUniqueName(obj.name || "Model");

    // Apply position offset
    duplicate.position.copy(obj.position).add(offset);
  }

  // Clear any existing helpers and list items
  delete duplicate.userData.boxHelper;
  delete duplicate.userData.parentBoxHelper;
  delete duplicate.userData.dimGroup;
  delete duplicate.userData.listItem;

  return duplicate;
}

function generateUniqueName(baseName) {
  const existingNames = new Set();
  scene.traverse(obj => {
    if (obj.name) existingNames.add(obj.name);
  });

  let counter = 1;
  let newName = `${baseName} Copy`;

  while (existingNames.has(newName)) {
    counter++;
    newName = `${baseName} Copy ${counter}`;
  }

  return newName;
}

function duplicateSelectedObjects() {
  if (selectedObjects.length === 0) return;

  const duplicates = [];
  const offset = new THREE.Vector3(1, 0, 1); // Default offset for non-gizmo duplication

  selectedObjects.forEach(obj => {
    const duplicate = duplicateObject(obj, offset);
    if (duplicate) {
      // Add to scene (or parent group if original was in a group)
      const originalParent = obj.parent;
      if (originalParent && originalParent.userData?.isEditorGroup && originalParent !== scene) {
        // If original was in a group, add duplicate to the same group
        originalParent.add(duplicate);
        // Update the parent group's sidebar
        rebuildGroupSidebar(originalParent);
      } else {
        // Add to scene
        scene.add(duplicate);
        // Add to sidebar
        if (duplicate.userData?.isEditorGroup) {
          addGroupToList(duplicate, duplicate.name);
        } else {
          addModelToList(duplicate, duplicate.name);
        }
      }

      createBoxHelperFor(duplicate);

      // Store initial transform and apply canvas constraints
      storeInitialTransform(duplicate);
      clampToCanvasRecursive(duplicate);
      updateAllVisuals(duplicate);

      duplicates.push(duplicate);
    }
  });

  // Select the duplicated objects
  if (duplicates.length > 0) {
    selectedObjects.forEach(obj => {
      obj.userData.listItem?.classList.remove("selected");
      setHelperVisible(obj, false);
      if (obj.userData.dimGroup) scene.remove(obj.userData.dimGroup);
    });

    selectedObjects = [...duplicates];
    selectedObject = duplicates[duplicates.length - 1];

    duplicates.forEach(obj => {
      obj.userData.listItem?.classList.add("selected");
      setHelperVisible(obj, true);
      updateBoxHelper(obj, BOX_COLORS.selected);
      addBoundingBoxDimensions(obj);
    });

    updateModelProperties(selectedObject);
    updatePropertiesPanel(selectedObject);
    updateTransformButtonStates();

    // Attach transform to the last selected duplicate
    if (selectedObject && isEditingAllowed()) {
      transform.attach(selectedObject);
    }

    saveState();
  }
}

// ===== Delete =====
function deleteObject(obj){
  if(!obj) return;
  if(transform.object===obj) transform.detach();

  // Remember the parent group before deletion
  const parentGroup = obj.parent && obj.parent.userData?.isEditorGroup ? obj.parent : null;

  if (obj instanceof THREE.Group) {
    const children = [...obj.children];
    children.forEach(child=>{
      cleanupObject(child);
      obj.remove(child);
    });
  }
  cleanupObject(obj);
  if(obj.parent) obj.parent.remove(obj);
  selectedObjects = selectedObjects.filter(o=>o!==obj);
  if(selectedObject===obj) selectedObject=null;
  updatePropertiesPanel(selectedObject||null);

  // After deletion, check if parent group should be removed
  if (parentGroup) {
    cleanupEmptyParentGroups(parentGroup);
  }
}

// ===== Camera helpers =====
function animateCamera(toPos, toTarget, duration=800){
  const fromPos = camera.position.clone();
  const fromTarget = orbit.target.clone();
  const start = performance.now();
  const ease = t => (t<0.5?2*t*t:-1+(4-2*t)*t);
  function step(now){
    const t = Math.min(1, (now-start)/duration);
    const k = ease(t);
    camera.position.lerpVectors(fromPos, toPos, k);
    orbit.target.lerpVectors(fromTarget, toTarget, k);
    camera.lookAt(orbit.target);
    if (t<1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

function frameCameraOn(obj){
  const box = getBox(obj);
  const sizeLen = box.getSize(new THREE.Vector3()).length();
  const center = box.getCenter(new THREE.Vector3());
  const newPos = center.clone().add(new THREE.Vector3(sizeLen,sizeLen,sizeLen));
  animateCamera(newPos, center);
}

function resetCamera(){
  if(selectedObject) frameCameraOn(selectedObject);
  else animateCamera(new THREE.Vector3(groundSize,groundSize,groundSize), new THREE.Vector3(0,0,0));
}

// ===== Canvas size & snap =====
canvasSizeInput.addEventListener("change", e=>{
  groundSize = parseFloat(e.target.value) || 20;
  scene.remove(grid);
  grid = new THREE.GridHelper(groundSize, groundSize, 0x888888, 0x444444);
  grid.userData.isSelectable = false;
  scene.add(grid);
  if (ruler) scene.remove(ruler);
  if (loadedFont) {
    ruler = createRuler(groundSize,1);
    addRulerLabels(ruler,groundSize,1,loadedFont);
    ruler.userData.isSelectable = false;
    scene.add(ruler);
  }
  orbit.maxDistance = groundSize * 1.5;
  selectedObjects.forEach(o=>updateAllVisuals(o));
});

snapCheckbox.addEventListener("change", e=>{
  const enabled = e.target.checked;
  transform.setTranslationSnap(enabled?1:null);
  transform.setRotationSnap(enabled?THREE.MathUtils.degToRad(15):null);
});

// ===== Hover & selection (canvas) =====
renderer.domElement.addEventListener("mousemove", e=>{
  const rect = renderer.domElement.getBoundingClientRect();
  const mouse = new THREE.Vector2(
    ((e.clientX-rect.left)/rect.width)*2-1,
    -((e.clientY-rect.top)/rect.height)*2+1
  );
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(mouse, camera);
  const hits = raycaster.intersectObjects(scene.children, true);
  let obj = null;
  if (hits.length>0){
    obj = hits[0].object;
    while (obj.parent && !obj.userData.isSelectable) obj = obj.parent;
    if (!obj.userData.isSelectable) obj = null;
  }
  if (hoveredObject && !selectedObjects.includes(hoveredObject)) setHelperVisible(hoveredObject,false);
  hoveredObject = obj;
  if (hoveredObject && !selectedObjects.includes(hoveredObject)){
    updateBoxHelper(hoveredObject, BOX_COLORS.hover);
    setHelperVisible(hoveredObject,true);
  }
});

renderer.domElement.addEventListener("click", e=>{
  const rect = renderer.domElement.getBoundingClientRect();
  const mouse = new THREE.Vector2(
    ((e.clientX-rect.left)/rect.width)*2-1,
    -((e.clientY-rect.top)/rect.height)*2+1
  );
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(mouse, camera);
  const hits = raycaster.intersectObjects(scene.children, true);
  if (hits.length>0){
    let obj = hits[0].object;
    while (obj.parent && !obj.userData.isSelectable) obj = obj.parent;
    if (obj.userData.isSelectable){
      selectFromCanvas(obj, e.shiftKey);
      frameCameraOn(obj);
    }
  }
});

// ===== Double-click focus =====
renderer.domElement.addEventListener("dblclick", e=>{
  if (transform.dragging) return;
  const rect = renderer.domElement.getBoundingClientRect();
  const mouse = new THREE.Vector2(
    ((e.clientX-rect.left)/rect.width)*2-1,
    -((e.clientY-rect.top)/rect.height)*2+1
  );
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(mouse, camera);
  const hits = raycaster.intersectObjects(scene.children, true);
  let target = null;
  if (hits.length>0){
    let obj = hits[0].object;
    while (obj.parent && !obj.userData.isSelectable) obj = obj.parent;
    if (obj.userData.isSelectable) target = obj;
  }
  if (target) { selectFromCanvas(target, false); frameCameraOn(target); }
  else resetCamera();
});

// ===== Keyboard shortcuts =====
window.addEventListener("keydown", e=>{
  const key = e.key.toLowerCase();
  const inForm = (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA");
  const isHotkey = ["w","e","r","q","f","h","z","delete","d","alt"].includes(key);
  if (inForm && !isHotkey) return;

  // Track Alt key for duplication
  if (key === "alt") {
    isAltPressed = true;
  }

  switch(key){
    case "w":
      if (isEditingAllowed()) transform.setMode("translate");
      break;
    case "e":
      if (isEditingAllowed()) transform.setMode("rotate");
      break;
    case "r":
      if (isEditingAllowed()) transform.setMode("scale");
      break;
    case "q":
      if(e.shiftKey){ if(selectedObject) transform.attach(selectedObject); }
      else transform.detach();
      break;
    case "f": if(selectedObject) frameCameraOn(selectedObject); break;
    case "h": {
      const helpOverlay = document.getElementById("helpOverlay");
      if(helpOverlay) helpOverlay.style.display = (helpOverlay.style.display==="none"||helpOverlay.style.display==="")?"block":"none";
      break;
    }
    case "delete":
      if(selectedObjects.length) [...selectedObjects].forEach(deleteObject);
      else if (selectedObject) deleteObject(selectedObject);
      break;
    case "d":
      if ((e.ctrlKey || e.metaKey) && !inForm) {
        e.preventDefault();
        duplicateSelectedObjects();
      }
      break;
    default:
      if ((e.ctrlKey||e.metaKey) && key==="z"){ e.preventDefault(); undo(); }
      break;
  }
});

window.addEventListener("keyup", e=>{
  const key = e.key.toLowerCase();

  // Track Alt key release
  if (key === "alt") {
    isAltPressed = false;
  }
});

// ===== Fix #ui buttons =====
btnTranslate.onclick = () => {
  if (isEditingAllowed()) transform.setMode("translate");
};
btnRotate.onclick = () => {
  if (isEditingAllowed()) transform.setMode("rotate");
};
btnScale.onclick = () => {
  if (isEditingAllowed()) transform.setMode("scale");
};
btnDelete.onclick = () => {
  if(selectedObjects.length) [...selectedObjects].forEach(deleteObject);
  else if (selectedObject) deleteObject(selectedObject);
};
btnUndo.onclick = () => undo();
btnResetCamera.onclick = () => resetCamera();

// ===== Resize =====
window.addEventListener("resize", ()=>{
  camera.aspect = window.innerWidth/window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  selectedObjects.forEach(o=>updateBoxHelper(o));
  if (hoveredObject) updateBoxHelper(hoveredObject);
});

// ===== Transform events =====
transform.addEventListener("dragging-changed", e=>{
  orbit.enabled = !e.value;

  if (e.value) {
    // Starting to drag
    if (isAltPressed && selectedObject && !isDuplicating) {
      // Create duplicate and switch to it
      isDuplicating = true;
      originalObject = selectedObject;

      const duplicate = duplicateObject(selectedObject, new THREE.Vector3(0, 0, 0)); // No initial offset for gizmo duplication
      if (duplicate) {
        // Add to scene (or parent group if original was in a group)
        const originalParent = selectedObject.parent;
        if (originalParent && originalParent.userData?.isEditorGroup && originalParent !== scene) {
          // If original was in a group, add duplicate to the same group
          originalParent.add(duplicate);
          // Update the parent group's sidebar
          rebuildGroupSidebar(originalParent);
        } else {
          // Add to scene
          scene.add(duplicate);
          // Add to sidebar
          if (duplicate.userData?.isEditorGroup) {
            addGroupToList(duplicate, duplicate.name);
          } else {
            addModelToList(duplicate, duplicate.name);
          }
        }

        createBoxHelperFor(duplicate);

        // Store initial transform and apply canvas constraints
        storeInitialTransform(duplicate);

        // Switch selection to duplicate
        selectedObjects.forEach(obj => {
          obj.userData.listItem?.classList.remove("selected");
          setHelperVisible(obj, false);
          if (obj.userData.dimGroup) scene.remove(obj.userData.dimGroup);
        });

        selectedObjects = [duplicate];
        selectedObject = duplicate;

        duplicate.userData.listItem?.classList.add("selected");
        setHelperVisible(duplicate, true);
        updateBoxHelper(duplicate, BOX_COLORS.editing);

        // Attach transform to duplicate
        transform.attach(duplicate);

        updateModelProperties(duplicate);
        updatePropertiesPanel(duplicate);
      }
    }
  } else {
    // Finished dragging
    if (isDuplicating) {
      isDuplicating = false;
      originalObject = null;

      // Apply canvas constraints to the duplicate
      if (selectedObject) {
        clampToCanvasRecursive(selectedObject);
        updateAllVisuals(selectedObject);
        addBoundingBoxDimensions(selectedObject);
      }
    } else {
      // Apply clamping after any transform operation is completed
      if (selectedObject) {
        clampToCanvasRecursive(selectedObject);
        updateAllVisuals(selectedObject);
      }
    }

    selectedObjects.forEach(o=>{
      updateBoxHelper(o, BOX_COLORS.selected);
      setHelperVisible(o,true);
    });

    if (!isDuplicating) saveState();
  }
});

transform.addEventListener("objectChange", ()=>{
  if(!selectedObject) return;

  const mode = transform.getMode();

  if(mode === "scale"){
    const s = selectedObject.scale.x;
    selectedObject.scale.set(s,s,s);
    snapUniformScale(selectedObject, SNAP_STEP);
  }

  // Don't clamp during rotation to avoid interfering with the rotation gizmo
  if(mode === "rotate") {
    // Only update visuals without clamping during rotation
    updateModelProperties(selectedObject);
    updatePropertiesPanel(selectedObject);
    updateBoxHelper(selectedObject);

    // If this is a group, also update child bounding boxes
    if (selectedObject.userData?.isEditorGroup) {
      updateChildBoundingBoxes(selectedObject);
    }

    // If this object is a child in a group, update the parent group's bounding box
    if (isChildObjectInGroup(selectedObject) && selectedObject.parent) {
      updateParentGroupBounds(selectedObject.parent);
    }

    // Only add dimension labels for selected objects
    if(selectedObjects.includes(selectedObject)) {
      addBoundingBoxDimensions(selectedObject);
    }
  } else {
    // For translate and scale modes, use full updateAllVisuals (including clamping)
    updateAllVisuals(selectedObject);
  }
});

// ===== Undo =====
const undoStack = [];
function saveState(){
  if (selectedObject) {
    undoStack.push({
      uuid: selectedObject.uuid,
      pos: selectedObject.position.clone(),
      rot: selectedObject.quaternion.clone(),
      scale: selectedObject.scale.clone()
    });
  }
}
function undo(){
  if (!selectedObject || !undoStack.length) return;

  // Find the most recent state for the currently selected object
  for (let i = undoStack.length - 1; i >= 0; i--){
    if (undoStack[i].uuid === selectedObject.uuid){
      const last = undoStack.splice(i, 1)[0];
      selectedObject.position.copy(last.pos);
      selectedObject.quaternion.copy(last.rot);
      selectedObject.scale.copy(last.scale);
      updateAllVisuals(selectedObject);
      break;
    }
  }
}

// ===== Render loop =====
function animate(){
  requestAnimationFrame(animate);
  orbit.update();
  renderer.render(scene, camera);
}
animate();

// ===== Context menu =====
const contextMenu = (function(){
  const menu = document.createElement('ul');
  menu.id = 'contextMenu';
  document.body.appendChild(menu);
  return menu;
})();

const contextActions = {
  "Duplicate": () => duplicateSelectedObjects(),
  "Dissolve Group": () => ungroupSelectedObject(),
  "Detach from Group": () => detachSelectedFromGroup(),
  "Reset Transform": () => selectedObjects.forEach(resetTransform),
  "Drop to Floor": () => selectedObjects.forEach(dropToFloor),
  "Select All": () => selectAllSidebar(),
  "Deselect All": () => deselectAllSidebar()
};

function showContextMenu(x,y,actions){
  contextMenu.innerHTML = "";
  actions.forEach(action=>{
    const li = document.createElement("li");
    li.textContent = action;
    li.style.padding = "4px 12px";
    li.style.cursor = "pointer";
    li.onmouseenter = () => li.style.background = "#444";
    li.onmouseleave = () => li.style.background = "transparent";
    li.onclick = () => { contextMenu.style.display="none"; contextActions[action]?.(); };
    contextMenu.appendChild(li);
  });
  contextMenu.style.left = x+"px";
  contextMenu.style.top = y+"px";
  contextMenu.style.display = "block";
}
document.addEventListener("click", ()=> contextMenu.style.display="none");

// Canvas context menu
renderer.domElement.addEventListener("contextmenu", e=>{
  e.preventDefault();
  let actions = ["Select All","Deselect All"];
  if (selectedObjects.length > 0) {
    actions = ["Duplicate","Reset Transform","Drop to Floor","Select All","Deselect All"];

    if (selectedObjects.length === 1) {
      const obj = selectedObjects[0];
      // If it's a parent group, show "Detach" to dissolve the entire group
      if ((obj instanceof THREE.Group) && obj.userData?.isEditorGroup === true) {
        actions.splice(1, 0, "Dissolve Group"); // Insert "Detach" after "Duplicate"
      }
      // If it's a child in a group with at least 2 non-parent children, show "Detach from Group"
      else if (isChildObjectInGroup(obj)) {
        const parentGroup = obj.parent;
        if (parentGroup.children.length >= 3) {
          actions.splice(1, 0, "Detach from Group");
        } else {
          // Only 1 non-parent child left, show "Detach" to dissolve the group
          actions.splice(1, 0, "Dissolve Group");
        }
      }
    } else {
      // Multiple objects selected - check if any are children in groups with enough children
      const hasDetachableChildren = selectedObjects.some(obj => {
        if (!isChildObjectInGroup(obj)) return false;
        const parentGroup = obj.parent;
        return parentGroup.children.length >= 3;
      });
      if (hasDetachableChildren) {
        actions.splice(1, 0, "Detach from Group");
      }
    }
  }
  showContextMenu(e.clientX, e.clientY, actions);
});

// Sidebar context menu
modelList.addEventListener("contextmenu", e=>{
  e.preventDefault();
  const li = e.target.closest("li");
  if (!li) return;
  const obj = findObjectByListItem(li);
  if (!obj) return;
  if (!selectedObjects.includes(obj)) selectFromSidebar(obj, li, e);

  let actions = ["Select All","Deselect All"];
  if (selectedObjects.length > 0) {
    actions = ["Duplicate","Reset Transform","Drop to Floor","Select All","Deselect All"];

    if (selectedObjects.length === 1) {
      // If it's a parent group, show "Detach" to dissolve the entire group
      if ((obj instanceof THREE.Group) && obj.userData?.isEditorGroup === true) {
        actions.splice(1, 0, "Dissolve Group"); // Insert "Detach" after "Duplicate"
      }
      // If it's a child in a group with at least 2 non-parent children, show "Detach from Group"
      else if (isChildObjectInGroup(obj)) {
        const parentGroup = obj.parent;
        if (parentGroup.children.length >= 3) {
          actions.splice(1, 0, "Detach from Group");
        } else {
          // Only 1 non-parent child left, show "Detach" to dissolve the group
          actions.splice(1, 0, "Dissolve Group");
        }
      }
    } else {
      // Multiple objects selected - check if any are children in groups with enough children
      const hasDetachableChildren = selectedObjects.some(obj => {
        if (!isChildObjectInGroup(obj)) return false;
        const parentGroup = obj.parent;
        return parentGroup.children.length >= 3;
      });
      if (hasDetachableChildren) {
        actions.splice(1, 0, "Detach from Group");
      }
    }
  }
  showContextMenu(e.clientX, e.clientY, actions);
});

function findObjectByListItem(li){
  let found = null;
  scene.traverse(obj=>{
    if (obj.userData?.listItem === li) found = obj;
  });
  return found;
}

function selectAllSidebar(){
  deselectAllSidebar();
  const topItems = [...modelList.querySelectorAll(":scope > li")];
  topItems.forEach(li=>{
    const obj = findObjectByListItem(li);
    if (obj?.userData.isSelectable){
      li.classList.add("selected");
      selectedObjects.push(obj);
      setHelperVisible(obj,true);
      updateBoxHelper(obj, BOX_COLORS.selected);
      addBoundingBoxDimensions(obj);
    }
  });
  selectedObject = selectedObjects[selectedObjects.length-1] || null;
  if (selectedObject){
    updateModelProperties(selectedObject);
    updatePropertiesPanel(selectedObject);
  }
  updateTransformButtonStates();
}

function deselectAllSidebar(){
  selectedObjects.forEach(o=>{
    o.userData.listItem?.classList.remove("selected");
    setHelperVisible(o,false);
    // Hide parent box helper if object is a child in a group
    if (isChildObjectInGroup(o) && o.parent) {
      setParentHelperVisible(o.parent, false);
    }
    // Hide child bounding boxes if object is a group
    if (o.userData?.isEditorGroup) {
      showChildBoundingBoxes(o, false);
    }
    if (o.userData.dimGroup) scene.remove(o.userData.dimGroup);
  });
  selectedObjects = [];
  selectedObject = null;
  transform.detach();
  updatePropertiesPanel(null);
  updateTransformButtonStates();
}


// ===== Export JSON (quaternions) =====
document.getElementById("exportJson").onclick = ()=>{
  function buildNode(obj){
    if (!obj.userData?.isSelectable) return null;
    const box = new THREE.Box3().setFromObject(obj);
    const size = box.getSize(new THREE.Vector3());

    // Get world position for accurate meter measurements
    const worldPosition = new THREE.Vector3();
    obj.getWorldPosition(worldPosition);

    // Get world quaternion for accurate rotation
    const worldQuaternion = new THREE.Quaternion();
    obj.getWorldQuaternion(worldQuaternion);

    // Get world scale
    const worldScale = new THREE.Vector3();
    obj.getWorldScale(worldScale);

    const rawName = (obj.name && obj.name.length) ? obj.name :
      (obj.userData.listItem ? obj.userData.listItem.textContent : "FILE");
    const baseName = rawName.replace(/\.[^/.]+$/, "");
    const sourceRef = obj.userData?.sourceRef;

    const node = {
      pResource: {
        sName: baseName,
        sReference: (obj instanceof THREE.Group && obj.userData?.isEditorGroup === true)
          ? (obj.children[0]?.userData?.sourceRef?.reference || (baseName + ".glb"))
          : (sourceRef?.reference || (baseName + ".glb"))
      },
      pTransform: {
        aPosition: [worldPosition.x, worldPosition.y, worldPosition.z],
        aRotation: [worldQuaternion.x, worldQuaternion.y, worldQuaternion.z, worldQuaternion.w],
        aScale: [worldScale.x, worldScale.y, worldScale.z]
      },
      aBound: [size.x, size.y, size.z],
      aChildren: []
    };

    if (obj instanceof THREE.Group) {
      // For editor groups, skip the first child (parent object) and only export other children
      const childrenToExport = obj.userData?.isEditorGroup === true
        ? obj.children.slice(1)
        : obj.children;

      childrenToExport.forEach(child=>{
        const childNode = buildNode(child);
        if (childNode) node.aChildren.push(childNode);
      });
    }

    return node;
  }
  const exportData = [];
  scene.children.forEach(obj=>{
    const node = buildNode(obj);
    if (node) exportData.push(node);
  });
  const jsonText = JSON.stringify(exportData, null, 2);
  const blob = new Blob([jsonText], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "index.msf.json"; a.click();
  URL.revokeObjectURL(url);
};
